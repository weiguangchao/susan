/**
 * susan 0.0.1 TUI 布局与交互原型（throwaway）
 *
 * 回答 wayfinder 票「原型：TUI 布局与交互（消息流、Tool 过程、审批弹窗）」：
 * 消息流与输入区布局、多行输入、流式输出追加、读文件 Tool 过程展示、
 * 逐次审批弹窗与快捷键、Ctrl+C 中断、/exit、/clear，
 * 以及 #16 已定的重试/失败/中断/Pending 交互状态。
 *
 * 模型响应全部 mock；读文件 Tool 真实读取文件以产生真实摘要。
 * 两种布局：Tab 切换 A（底部固定输入区）/ B（输入区内联在消息流末尾）。
 */
import React, { useEffect, useRef, useState } from 'react';
import { render, Box, Text, useApp, useInput } from 'ink';
import { readFileSync } from 'node:fs';
import { PassThrough } from 'node:stream';
import { resolve } from 'node:path';

type Phase =
  | 'idle'
  | 'streaming'
  | 'approval'
  | 'tool-running'
  | 'retrying'
  | 'failed';

type RetryKind = 'interrupted' | 'failed' | null;

interface Message {
  role: 'user' | 'assistant';
  text: string;
}

type ToolStatus = 'waiting' | 'running' | 'ok' | 'denied' | 'error';

interface ToolRec {
  id: number;
  name: string;
  argsText: string;
  path: string;
  status: ToolStatus;
  summary?: string;
  preview?: string[];
}

type Item =
  | { kind: 'message'; message: Message }
  | { kind: 'tool'; tool: ToolRec }
  | { kind: 'interrupted'; text: string };

interface RetryState {
  reason: string;
  attempt: number;
  total: number;
  waitMs: number;
  remainMs: number;
}

interface FailureState {
  status: number;
  message: string;
  requestId: string;
}

const REPLY = '这是 mock 回复，用于演示流式输出追加。susan 0.0.1 是个人使用的 harness agent：Agent Loop 串行执行 Tool Batch、逐次审批，读文件 Tool 返回结构化分页结果。';
const LONG_REPLY =
  '这是一段较长的 mock 回复，用来演示 Ctrl+C 中断。中断后本响应成为 Interrupted Response，保留在 TUI 但不作为完整 assistant message 写入 Session Transcript；恢复 Session 时只能由用户显式重试。你可以现在按 Ctrl+C 试试。继续输出一些内容填充长度，模拟真实生成节奏。';
const RETRY_OK = '（第 3 次请求成功）网络已恢复，下面是完整回复：Harness 统一控制 Provider 重试，最多两次，退避 1s/2s。';
const RESUME_OK = '（显式重试成功）继续昨天的结论：Harness 统一控制 Provider 重试，streaming 产生语义输出后不自动重放。';

function fmtBytes(n: number): string {
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KiB`;
  return `${n} B`;
}

function visibleWidth(s: string): number {
  let w = 0;
  for (const ch of s) {
    const cp = ch.codePointAt(0) ?? 0;
    w += cp > 0x2e7f ? 2 : 1;
  }
  return w;
}

function wrap(text: string, width: number): string[] {
  const out: string[] = [];
  for (const para of text.split('\n')) {
    let line = '';
    let lw = 0;
    for (const ch of para) {
      const cw = visibleWidth(ch);
      if (lw + cw > width) {
        out.push(line);
        line = ch;
        lw = cw;
      } else {
        line += ch;
        lw += cw;
      }
    }
    out.push(line);
  }
  return out;
}

function useTerminalSize() {
  const [size, setSize] = useState(() => ({
    columns: process.stdout.columns || 80,
    rows: process.stdout.rows || 24,
  }));
  useEffect(() => {
    const onResize = () =>
      setSize({ columns: process.stdout.columns || 80, rows: process.stdout.rows || 24 });
    process.stdout.on('resize', onResize);
    return () => void process.stdout.off('resize', onResize);
  }, []);
  return size;
}

function App() {
  const { exit } = useApp();
  const { columns, rows } = useTerminalSize();

  const [items, setItems] = useState<Item[]>([]);
  const [stream, setStream] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>('idle');
  const [retry, setRetry] = useState<RetryState | null>(null);
  const [failure, setFailure] = useState<FailureState | null>(null);
  const [approval, setApproval] = useState<ToolRec | null>(null);
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [input, setInput] = useState<string[]>(['']);
  const [cursor, setCursor] = useState({ line: 0, col: 0 });
  const [layout, setLayout] = useState<'A' | 'B'>('A');

  const phaseRef = useRef<Phase>(phase);
  const approvalRef = useRef<ToolRec | null>(null);
  const streamRef = useRef<string | null>(null);
  const retryKindRef = useRef<RetryKind>(null);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const streamTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const nextId = useRef(1);
  const runningToolRef = useRef<number | null>(null);

  useEffect(() => {
    phaseRef.current = phase;
  }, [phase]);

  useEffect(
    () => () => {
      timers.current.forEach(clearTimeout);
      if (streamTimer.current) clearInterval(streamTimer.current);
    },
    [],
  );

  const later = (ms: number, fn: () => void) => {
    const t = setTimeout(fn, ms);
    timers.current.push(t);
  };

  const pushMessage = (role: 'user' | 'assistant', text: string) =>
    setItems((prev) => [...prev, { kind: 'message', message: { role, text } }]);

  const updateTool = (id: number, patch: Partial<ToolRec>) =>
    setItems((prev) =>
      prev.map((it) =>
        it.kind === 'tool' && it.tool.id === id
          ? { kind: 'tool' as const, tool: { ...it.tool, ...patch } }
          : it,
      ),
    );

  const clearInput = () => {
    setInput(['']);
    setCursor({ line: 0, col: 0 });
  };

  const streamText = (full: string, then?: () => void) => {
    setPhase('streaming');
    setStream('');
    streamRef.current = '';
    let i = 0;
    streamTimer.current = setInterval(() => {
      i = Math.min(full.length, i + 7);
      const acc = full.slice(0, i);
      streamRef.current = acc;
      setStream(acc);
      if (i >= full.length) {
        if (streamTimer.current) clearInterval(streamTimer.current);
        streamTimer.current = null;
        setStream(null);
        streamRef.current = null;
        pushMessage('assistant', acc);
        setPhase('idle');
        then?.();
      }
    }, 45);
  };

  const stopStream = () => {
    if (streamTimer.current) clearInterval(streamTimer.current);
    streamTimer.current = null;
  };

  // ---- Tool ----

  const tryRead = (
    path: string,
  ):
    | { ok: true; lines: number; bytes: number; truncated: boolean; preview: string[] }
    | { ok: false; code: string; message: string } => {
    const abs = path.startsWith('/') ? path : resolve(process.cwd(), path);
    try {
      const buf = readFileSync(abs);
      if (buf.subarray(0, 8192).includes(0)) {
        return { ok: false, code: 'EBINARY', message: '非文本文件（含 NUL）' };
      }
      const text = buf.toString('utf8');
      const lines = text.split('\n');
      return {
        ok: true,
        lines: lines.length,
        bytes: buf.length,
        truncated: buf.length > 50 * 1024,
        preview: lines.slice(0, 2).map((l) => l.slice(0, 60)),
      };
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      const code =
        err.code === 'ENOENT'
          ? 'ENOENT'
          : err.code === 'EACCES'
            ? 'EACCES'
            : err.code === 'EISDIR'
              ? 'EISDIR'
              : 'ETOOL';
      return { ok: false, code, message: String(err.message ?? err).split('\n')[0] };
    }
  };

  const startToolCall = (path: string) => {
    const rec: ToolRec = {
      id: nextId.current++,
      name: '读取',
      argsText: `${path} offset=1 limit=2000`,
      path,
      status: 'waiting',
    };
    setItems((prev) => [...prev, { kind: 'tool', tool: rec }]);
    setApproval(rec);
    approvalRef.current = rec;
    setPhase('approval');
  };

  const approve = (rec: ToolRec) => {
    setApproval(null);
    approvalRef.current = null;
    setPhase('tool-running');
    runningToolRef.current = rec.id;
    updateTool(rec.id, { status: 'running' });
    later(900, () => {
      const result = tryRead(rec.path);
      if (result.ok) {
        updateTool(rec.id, {
          status: 'ok',
          summary: `${result.lines} 行 · ${fmtBytes(result.bytes)}${result.truncated ? ' · 截断于 50 KiB' : ''}`,
          preview: result.preview,
        });
        streamText('读完了，内容摘要如上。需要我总结或继续读取下一页吗？');
      } else {
        updateTool(rec.id, {
          status: 'error',
          summary: `${result.code} · ${result.message}`,
        });
        streamText('读取失败，这个错误会作为失败 Tool Result 回传模型，Agent Loop 继续。');
      }
    });
  };

  const deny = (rec: ToolRec) => {
    setApproval(null);
    approvalRef.current = null;
    setPhase('idle');
    updateTool(rec.id, { status: 'denied', summary: 'EAPPROVAL_DENIED · 已拒绝' });
    streamText('好，我不读取该文件。还需要我做什么？');
  };

  // ---- 重试 / 失败 / 中断 ----

  const runRetrySeq = (attempts: { reason: string; waitMs: number }[], finalFail: boolean) => {
    let i = 0;
    const next = () => {
      if (i >= attempts.length) {
        setRetry(null);
        if (finalFail) {
          setFailure({ status: 503, message: 'Service Unavailable', requestId: 'req_xk9f2a3c' });
          setPhase('failed');
          retryKindRef.current = 'failed';
        } else {
          streamText(RETRY_OK);
        }
        return;
      }
      const a = attempts[i++];
      const start = Date.now();
      setPhase('retrying');
      retryKindRef.current = null;
      setRetry({ reason: a.reason, attempt: i, total: attempts.length, waitMs: a.waitMs, remainMs: a.waitMs });
      const iv = setInterval(() => {
        const remain = Math.max(0, a.waitMs - (Date.now() - start));
        setRetry((r) => (r ? { ...r, remainMs: remain } : r));
        if (remain <= 0) {
          clearInterval(iv);
          next();
        }
      }, 100);
      timers.current.push(iv as unknown as ReturnType<typeof setTimeout>);
    };
    next();
  };

  const retryFailed = () => {
    setFailure(null);
    retryKindRef.current = null;
    setNotice(null);
    streamText(RESUME_OK);
  };

  const retryInterrupted = () => {
    retryKindRef.current = null;
    setNotice(null);
    streamText(RETRY_OK);
  };

  const giveUpFailure = () => {
    setFailure(null);
    setPhase('idle');
    setNotice('已放弃重试；该 Agent Loop 保持 Pending，可输入新消息或 /exit');
  };

  const resumePending = () => {
    setPending(false);
    streamText(RESUME_OK);
  };

  const dismissPending = () => {
    setPending(false);
    setNotice('继续新对话（旧 Session 已保留，可用 --resume 恢复）');
  };

  // ---- 中断 ----

  const interrupt = () => {
    const p = phaseRef.current;
    if (p === 'approval' && approvalRef.current) {
      deny(approvalRef.current);
      return;
    }
    if (p === 'tool-running') {
      if (runningToolRef.current !== null) {
        updateTool(runningToolRef.current, { status: 'error', summary: '已中断（Ctrl+C）' });
      }
      setPhase('idle');
      setNotice('已中断 Tool 执行，Agent Loop 停在稳定边界');
      return;
    }
    if (p === 'streaming' && streamRef.current !== null) {
      const partial = streamRef.current;
      stopStream();
      setStream(null);
      streamRef.current = null;
      setItems((prev) => [...prev, { kind: 'interrupted', text: partial }]);
      setPhase('idle');
      retryKindRef.current = 'interrupted';
      setNotice('响应已中断（Interrupted Response），未写入 Session Transcript · Enter 重试');
      return;
    }
    if (p === 'retrying') {
      setRetry(null);
      setPhase('idle');
      retryKindRef.current = 'interrupted';
      setNotice('已中断重试 · Enter 显式重试');
      return;
    }
    if (p === 'failed') {
      giveUpFailure();
      return;
    }
    // idle：有输入清空，无输入退出
    const text = input.map((l) => l.trimEnd()).join('\n').trim();
    if (text !== '') {
      clearInput();
      setNotice('已清空输入');
    } else {
      exit();
    }
  };

  // ---- 输入处理 ----

  const submit = () => {
    const text = input.map((l) => l.trimEnd()).join('\n').trim();
    if (text === '') {
      if (retryKindRef.current === 'failed') {
        retryFailed();
      } else if (retryKindRef.current === 'interrupted') {
        retryInterrupted();
      } else if (pending) {
        resumePending();
      }
      return;
    }
    clearInput();
    setNotice(null);
    if (text === '/exit') {
      exit();
      return;
    }
    if (text === '/clear') {
      setItems([]);
      setPending(false);
      setNotice('已开启新 Session（旧 Session 已保留）');
      return;
    }
    if (text === '/help') {
      setNotice('/demo tool | retry | fail | interrupt | pending · 含文件名的消息会触发读文件 Tool');
      return;
    }
    if (text.startsWith('/demo ')) {
      const cmd = text.slice(6);
      pushMessage('user', text);
      if (cmd === 'tool') {
        streamText('好的，演示读文件 Tool：先流式回复这句，然后发起 Tool Call。', () => startToolCall('AGENTS.md'));
      } else if (cmd === 'retry') {
        runRetrySeq(
          [
            { reason: '429 Too Many Requests', waitMs: 2000 },
            { reason: '429 Too Many Requests', waitMs: 2000 },
          ],
          false,
        );
      } else if (cmd === 'fail') {
        runRetrySeq(
          [
            { reason: '500 Internal Server Error', waitMs: 1200 },
            { reason: '503 Service Unavailable', waitMs: 1800 },
          ],
          true,
        );
      } else if (cmd === 'interrupt') {
        streamText(LONG_REPLY);
      } else if (cmd === 'pending') {
        setItems([
          { kind: 'message', message: { role: 'user', text: '继续昨天的任务' } },
          { kind: 'interrupted', text: '昨天的结论是：Harness 统一控制重试，streaming 产生语义输出后不自动重放，' },
        ]);
        setPending(true);
        retryKindRef.current = null;
      } else {
        setNotice(`未知演示命令：${cmd}（/help 查看）`);
      }
      return;
    }
    // 普通消息
    pushMessage('user', text);
    const fileMatch = text.match(/([\w./~-]+\.\w[\w.-]*)/);
    if (fileMatch || /读取|文件/.test(text)) {
      const path = fileMatch ? fileMatch[1] : 'AGENTS.md';
      streamText('好的，我先读一下这个文件。', () => startToolCall(path));
    } else {
      const brief = text.length > 30 ? `${text.slice(0, 30)}…` : text;
      streamText(`收到：「${brief}」。${REPLY}`);
    }
  };

  const insertText = (text: string) => {
    const start = cursor;
    setInput((prev) => {
      const lines = [...prev];
      let l = start.line;
      let c = start.col;
      for (const ch of text) {
        if (ch === '\r' || ch === '\n') {
          const cur = lines[l] ?? '';
          const tail = cur.slice(c);
          lines[l] = cur.slice(0, c);
          lines.splice(l + 1, 0, tail);
          l += 1;
          c = 0;
        } else {
          const cur = lines[l] ?? '';
          lines[l] = cur.slice(0, c) + ch + cur.slice(c);
          c += 1;
        }
      }
      return lines;
    });
    setCursor(({ line, col }) => {
      let l = line;
      let c = col;
      for (const ch of text) {
        if (ch === '\r' || ch === '\n') {
          l += 1;
          c = 0;
        } else {
          c += 1;
        }
      }
      return { line: l, col: c };
    });
  };

  const insertChar = (ch: string) => {
    setInput((prev) => {
      const lines = [...prev];
      const line = lines[cursor.line] ?? '';
      lines[cursor.line] = line.slice(0, cursor.col) + ch + line.slice(cursor.col);
      return lines;
    });
    setCursor((c) => ({ ...c, col: c.col + 1 }));
  };

  const newline = () => {
    setInput((prev) => {
      const lines = [...prev];
      const line = lines[cursor.line] ?? '';
      const tail = line.slice(cursor.col);
      lines[cursor.line] = line.slice(0, cursor.col);
      lines.splice(cursor.line + 1, 0, tail);
      return lines;
    });
    setCursor((c) => ({ line: c.line + 1, col: 0 }));
  };

  const backspace = () => {
    setInput((prev) => {
      const lines = [...prev];
      if (cursor.col > 0) {
        const line = lines[cursor.line] ?? '';
        lines[cursor.line] = line.slice(0, cursor.col - 1) + line.slice(cursor.col);
      } else if (cursor.line > 0) {
        const merged = (lines[cursor.line - 1] ?? '') + (lines[cursor.line] ?? '');
        lines[cursor.line - 1] = merged;
        lines.splice(cursor.line, 1);
      }
      return lines;
    });
    setCursor((c) => {
      if (c.col > 0) return { ...c, col: c.col - 1 };
      if (c.line > 0) {
        const prevLen = input[c.line - 1]?.length ?? 0;
        return { line: c.line - 1, col: prevLen };
      }
      return c;
    });
  };

  const moveCursor = (dl: number, dc: number) => {
    setCursor((c) => {
      const line = Math.max(0, Math.min(input.length - 1, c.line + dl));
      const col = Math.max(0, Math.min(input[line]?.length ?? 0, c.col + dc));
      return { line, col };
    });
  };

  const pendingInputEmpty = () => input.length === 1 && input[0] === '';

  useInput((inputKey, key) => {
    // 过滤 kitty keyboard 协商响应泄漏进输入管线的字节（如 "[?1u"）
    if (/^\x1b\[\?\d+u$/.test(inputKey) || /^\[\?\d+u$/.test(inputKey)) {
      return;
    }
    if (key.ctrl && inputKey === 'c') {
      interrupt();
      return;
    }
    if (key.ctrl && inputKey === 'j') {
      newline();
      return;
    }
    if (key.shift && inputKey === ' ') {
      newline();
      return;
    }
    if (key.ctrl && inputKey !== 'c') return;

    if (phase === 'approval' && approval) {
      if (key.return) approve(approval);
      else if (key.escape) deny(approval);
      return;
    }
    if (phase === 'failed') {
      if (key.return) retryFailed();
      else if (key.escape) giveUpFailure();
      return;
    }
    if (pending && pendingInputEmpty()) {
      if (inputKey === 'r') {
        resumePending();
        return;
      }
      if (inputKey === 'n') {
        dismissPending();
        return;
      }
    }
    if (key.tab) {
      setLayout((l) => (l === 'A' ? 'B' : 'A'));
      return;
    }
    if (inputKey === '\n') {
      newline();
      return;
    }
    if (key.return) {
      if (phase === 'idle' || phase === 'streaming' || phase === 'retrying') {
        if (phase !== 'idle') {
          setNotice('正在生成，Ctrl+C 可中断');
        } else {
          submit();
        }
      }
      return;
    }
    if (key.upArrow) {
      moveCursor(-1, 0);
      return;
    }
    if (key.downArrow) {
      moveCursor(1, 0);
      return;
    }
    if (key.leftArrow) {
      moveCursor(0, -1);
      return;
    }
    if (key.rightArrow) {
      moveCursor(0, 1);
      return;
    }
    if (key.backspace) {
      backspace();
      return;
    }
    if (key.delete) {
      return;
    }
    if (inputKey === '\n') return;
    if (inputKey.length >= 1 && !key.meta && !key.super && !key.ctrl) {
      insertText(inputKey);
    }
  });

  if (phase === 'approval' && approval) {
    return <ApprovalModal tool={approval} />;
  }

  const width = Math.max(60, columns);
  const inputLines = Math.min(input.length, 4);
  const reserved = 1 + 1 + inputLines + 2 + 1 + 2;
  const maxItems = Math.max(4, rows - reserved);
  const visible = items.slice(-maxItems);

  return (
    <Box flexDirection="column" width={width}>
      <Header layout={layout} />
      {pending && <PendingBanner />}
      <Box flexDirection="column">
        {visible.map((it, idx) => (
          <RenderItem key={idx} item={it} width={width - 2} />
        ))}
        {stream !== null && <StreamingText text={stream} width={width - 2} />}
        {layout === 'B' && <InlineComposer input={input} cursor={cursor} width={width - 2} />}
      </Box>
      {layout === 'A' && <StatusLine phase={phase} retry={retry} failure={failure} notice={notice} />}
      {layout === 'B' && <StatusLine phase={phase} retry={retry} failure={failure} notice={notice} />}
      {layout === 'A' && <InputBox input={input} cursor={cursor} />}
      <Footer layout={layout} />
    </Box>
  );
}

function Header({ layout }: { layout: 'A' | 'B' }) {
  return (
    <Box>
      <Text color="magenta" bold>
        susan
      </Text>
      <Text dimColor> · cwd: </Text>
      <Text color="blue">{process.cwd()}</Text>
      <Text dimColor> · yolo: 关 · 布局 {layout}</Text>
    </Box>
  );
}

function PendingBanner() {
  return (
    <Box>
      <Text color="yellow">
        ⚠ 上次响应未完成（Pending Agent Loop） · r 重试 · n 继续新对话
      </Text>
    </Box>
  );
}

function RenderItem({ item, width }: { item: Item; width: number }) {
  if (item.kind === 'message') {
    const m = item.message;
    if (m.role === 'user') {
      return (
        <Box flexDirection="column">
          {wrap(m.text, width - 7).map((l, i) => (
            <Text key={i}>
              {i === 0 ? <Text color="cyan">你 ▸ </Text> : <Text color="cyan">      </Text>}
              {l}
            </Text>
          ))}
        </Box>
      );
    }
    return (
      <Box flexDirection="column">
        {wrap(m.text, width - 7).map((l, i) => (
          <Text key={i}>
            {i === 0 ? <Text color="green">susan </Text> : <Text color="green">      </Text>}
            {l}
          </Text>
        ))}
      </Box>
    );
  }
  if (item.kind === 'interrupted') {
    return (
      <Box flexDirection="column">
        <Text color="red">susan [已中断] {item.text}</Text>
        <Text dimColor>      └ 未写入 Session Transcript · Enter 显式重试</Text>
      </Box>
    );
  }
  const t = item.tool;
  const statusLine = {
    waiting: () => <Text color="yellow">⏳ 等待审批…</Text>,
    running: () => <Text color="yellow">⏳ 读取中…</Text>,
    ok: () => <Text color="green">✓ 已读 {t.summary}</Text>,
    denied: () => <Text color="red">✗ {t.summary}</Text>,
    error: () => <Text color="red">✗ {t.summary}</Text>,
  }[t.status]();
  return (
    <Box flexDirection="column" borderStyle="single" borderColor="gray" paddingX={1} marginY={0}>
      <Text color="yellow">▸ {t.name} </Text>
      {wrap(t.argsText, width - 6).map((l, i) => (
        <Text key={i}>
          {i === 0 ? '' : ''}
          <Text color="blue">{i === 0 ? '  ' : '  '}{l}</Text>
        </Text>
      ))}
      <Box>{statusLine}</Box>
      {t.status === 'ok' &&
        t.preview?.map((l, i) => (
          <Text key={i} dimColor>
            {'  '}
            {l}
          </Text>
        ))}
    </Box>
  );
}

function StreamingText({ text, width }: { text: string; width: number }) {
  return (
    <Box flexDirection="column">
      {wrap(text, width - 7).map((l, i) => (
        <Text key={i}>
          {i === 0 ? <Text color="green">susan </Text> : <Text color="green">      </Text>}
          {l}
          <Text color="green">▍</Text>
        </Text>
      ))}
    </Box>
  );
}

function StatusLine({
  phase,
  retry,
  failure,
  notice,
}: {
  phase: Phase;
  retry: RetryState | null;
  failure: FailureState | null;
  notice: string | null;
}) {
  if (retry) {
    return (
      <Text color="yellow">
        ⏳ {retry.reason} · {(retry.remainMs / 1000).toFixed(1)} 秒后重试（{retry.attempt}/{retry.total}）
      </Text>
    );
  }
  if (failure) {
    return (
      <Text color="red">
        ⚠ Provider 请求失败 · {failure.status} {failure.message} · request_id: {failure.requestId} · Enter 重试 · Esc 放弃
      </Text>
    );
  }
  if (phase === 'streaming') return <Text color="yellow">▍ 生成中 · Ctrl+C 中断</Text>;
  if (phase === 'tool-running') return <Text color="yellow">⏳ Tool 执行中…</Text>;
  if (phase === 'retrying') return <Text color="yellow">⏳ 重试中…</Text>;
  if (notice) return <Text dimColor>{notice}</Text>;
  return <Text dimColor>输入消息，或 /help 查看演示命令</Text>;
}

function InputBox({ input, cursor }: { input: string[]; cursor: { line: number; col: number } }) {
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
      {input.map((line, li) => (
        <Text key={li}>
          {li === 0 ? <Text color="cyan">你 ▸ </Text> : <Text color="cyan">     </Text>}
          {cursor.line === li ? `${line.slice(0, cursor.col)}▍${line.slice(cursor.col)}` : line}
        </Text>
      ))}
    </Box>
  );
}

function InlineComposer({
  input,
  cursor,
  width,
}: {
  input: string[];
  cursor: { line: number; col: number };
  width: number;
}) {
  return (
    <Box flexDirection="column">
      {input.map((line, li) => (
        <Text key={li}>
          {li === 0 ? <Text color="cyan">你 ▸ </Text> : <Text color="cyan">     </Text>}
          {cursor.line === li ? `${line.slice(0, cursor.col)}▍${line.slice(cursor.col)}` : line}
        </Text>
      ))}
    </Box>
  );
}

function Footer({ layout }: { layout: 'A' | 'B' }) {
  return (
    <Text dimColor>
      Enter 发送 · Ctrl+J/Shift+空格 换行 · Ctrl+C 中断 · Tab {layout} · /exit /clear
    </Text>
  );
}

function ApprovalModal({ tool }: { tool: ToolRec }) {
  return (
    <Box
      flexDirection="column"
      borderStyle="double"
      borderColor="yellow"
      paddingX={2}
      width={64}
      marginX={2}
      marginY={2}
    >
      <Text color="yellow" bold>
        批准 Tool 调用？
      </Text>
      <Text color="yellow">▸ {tool.name}</Text>
      {wrap(tool.argsText, 56).map((l, i) => (
        <Text key={i} color="blue">
          {'  '}
          {l}
        </Text>
      ))}
      <Box>
        <Text color="green">Enter 允许</Text>
        <Text dimColor> · </Text>
        <Text color="red">Esc 拒绝</Text>
      </Box>
    </Box>
  );
}

// kitty keyboard 协议下，无修饰符的控制键形态（Ctrl+C = CSI 3u、Ctrl+J = CSI 10u）
// 会被 Ink 7 解析成空输入（不设 ctrl 标志）。这里在 stdin 入口把它们还原成 legacy 字节，
// 再交给 Ink；带修饰符形态（CSI 3;5u 等）与 Shift+空格 仍由 useInput 分支处理。
function createKittyShim() {
  const shim = new PassThrough();
  Object.defineProperties(shim, {
    isTTY: { get: () => process.stdin.isTTY },
    isRaw: { get: () => process.stdin.isRaw },
    fd: { get: () => process.stdin.fd },
  });
  const original = process.stdin;
  (shim as unknown as { setRawMode: (v: boolean) => NodeJS.ReadStream }).setRawMode = (v: boolean) => {
    original.setRawMode(v);
    return shim as unknown as NodeJS.ReadStream;
  };
  (shim as unknown as { ref: () => NodeJS.ReadStream }).ref = () => {
    original.ref();
    return shim as unknown as NodeJS.ReadStream;
  };
  (shim as unknown as { unref: () => NodeJS.ReadStream }).unref = () => {
    original.unref();
    return shim as unknown as NodeJS.ReadStream;
  };

  const seqs: Array<[string, string]> = [
    ['\x1b[3u', '\x03'],
    ['\x1b[10u', '\x0a'],
  ];
  const prefixes = ['\x1b', '\x1b[', '\x1b[1', '\x1b[10', '\x1b[3'];
  let tail = '';
  original.on('data', (chunk: Buffer) => {
    const text = tail + chunk.toString('utf8');
    tail = '';
    let out = '';
    let i = 0;
    while (i < text.length) {
      const hit = seqs.find(([seq]) => text.startsWith(seq, i));
      if (hit) {
        out += hit[1];
        i += hit[0].length;
        continue;
      }
      out += text[i];
      i += 1;
    }
    for (const p of prefixes) {
      if (out.endsWith(p)) {
        tail = p;
        out = out.slice(0, -p.length);
        break;
      }
    }
    if (out !== '') shim.write(out);
  });
  return shim as unknown as NodeJS.ReadStream;
}

render(<App />, {
  stdin: createKittyShim(),
  exitOnCtrlC: false,
  patchConsole: true,
  kittyKeyboard: { mode: 'auto' },
  debug: process.env.SUSAN_DEBUG === '1',
});
