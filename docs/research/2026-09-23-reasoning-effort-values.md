# Reasoning effort values in official provider documentation

Checked 2026-09-23 against OpenAI and Anthropic official documentation.

| Susan provider type | Request parameter | Documented API-level values |
| --- | --- | --- |
| `openai-completion` | Chat Completions `reasoning_effort` | `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max` |
| `responses` | Responses `reasoning.effort` | `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max` |
| `anthropic` | Messages `output_config.effort` | `low`, `medium`, `high`, `xhigh`, `max` |

OpenAI's [reasoning guide](https://developers.openai.com/api/docs/guides/reasoning) lists the seven values as *possible model-dependent values*. It names the Responses and Chat Completions parameter paths when explaining that `none` produces HTTP 400 with GPT-6 Astra. This supports the same broad value set for Susan's two OpenAI-compatible provider types, but does **not** say that each model supports every value. The guide directs readers to the specific model page before choosing a value. Its [model catalog](https://developers.openai.com/api/docs/models) lists GPT-6 Astra with `low` through `max`, and GPT-6 Sol and Luna with `none` through `max`; the catalog does not list `minimal` for these models. The [GPT-5.6 guide](https://developers.openai.com/api/docs/guides/latest-model?model=gpt-5.6) likewise lists `none`, `low`, `medium`, `high`, `xhigh`, `max` for that family. Thus `minimal` belongs in the broad API-level union but should not be presumed valid for current GPT-5.6/GPT-6 models. OpenAI's [GPT-4o model page](https://developers.openai.com/api/docs/models/gpt-4o) marks reasoning as unsupported; an OpenAI-compatible provider type alone does not establish that its configured model accepts reasoning effort.

The OpenAI guide also describes endpoint-specific limits: GPT-6 Astra function calling requires Responses; GPT-6 Sol and Luna function calling through Chat Completions works only with `reasoning_effort: "none"`, per the [GPT-6 model guide](https://developers.openai.com/api/docs/guides/latest-model). These restrictions do not alter the shared list of effort names, but they matter when constructing requests.

Anthropic's [Messages API reference](https://platform.claude.com/docs/en/api/http/messages) enumerates `low`, `medium`, `high`, `xhigh`, and `max` for `output_config.effort`. Its [effort guide](https://platform.claude.com/docs/en/build-with-claude/effort) states that support varies by model: Claude Sonnet 4.6 supports `max` but is absent from the `xhigh` availability list; Claude Opus 4.6 also supports `max` but is absent from the `xhigh` list. The guide explicitly says that not every model supporting `max` supports `xhigh`. It lists which model families support effort at all. `none` and `minimal` are not Anthropic effort levels.

Susan's `default` UI choice is a local action to omit the provider's effort parameter, not a provider API enum value. Anthropic says omission uses the model's default (`high` for most supported models, `medium` for Claude Opus 5.5). OpenAI says defaults are model-dependent; for example GPT-5.5 and GPT-5.6 default to `medium`. Sources: [Anthropic effort guide](https://platform.claude.com/docs/en/build-with-claude/effort), [OpenAI reasoning guide](https://developers.openai.com/api/docs/guides/reasoning).
