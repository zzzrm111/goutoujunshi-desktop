# 角色模型目录

- `character.sample.vrm`：three-vrm 官方示例（pixiv Inc. 提供，VRM 元数据允许再分发），公开版默认使用它。
- 仓库不附带走路动画。把自己的 `walk.vrma` 放在本目录即可启用；没有时自动退回程序化步态。

## 换成自己的模型

1. 把 `.vrm` 放到本目录。
2. 在 `apps/web/.env.local` 写入：

```dotenv
VITE_CHARACTER_MODEL_URL=models/your-character.vrm
```

3. 重启 `npm run dev`。

## 先确认授权

```powershell
python scripts/check-vrm-license.py apps/web/public/models/your-character.vrm
```

`allowRedistribution: false`、`avatarPermission: onlyAuthor`、`modification: prohibited` 的模型不要提交到公开仓库。

本目录的 `*.vrm` 已被 `.gitignore` 忽略，只放行 `character.sample.vrm`。
