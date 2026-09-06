# `--config` 指向 Susan Home 的父目录

`--config` 曾经直接指向 Config 文件，Session Store 却固定写在 `~/.susan/sessions/`，权限检查还去看 Config 旁边的 `sessions/`。0.0.1 把它改成父目录：Susan Home 固定是 `<dir>/.susan`，Config 与 Session Store 都落在其中；省略 flag 时父目录仍是用户 home。这样 `--config` 换的是整份家，而不是一份游离的 JSON；路径最后一段已经叫 `.susan` 也照套一层，避免把 flag 理解成 Home 本身。
