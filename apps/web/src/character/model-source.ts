/**
 * 角色模型地址解析。
 *
 * 公开版默认使用 three-vrm 官方示例模型 character.sample.vrm（pixiv 提供，允许再分发），
 * 这样仓库不包含任何禁止分发的第三方角色资产。
 *
 * 换成自己的模型时，二选一：
 * 1. 把文件放到 apps/web/public/models/，在 apps/web/.env.local 写入
 *    VITE_CHARACTER_MODEL_URL=models/你的模型.vrm
 * 2. 直接填完整地址（/ 开头或 http(s):// 开头）
 *
 * 注意：模型授权由使用者自行确认。禁止再分发（allowRedistribution=false）的
 * VRM 不要提交进 Git 仓库。
 */
const configured = (import.meta.env.VITE_CHARACTER_MODEL_URL ?? "").trim();

function resolve(value: string): string {
  if (value.startsWith("/") || /^https?:\/\//i.test(value)) return value;
  return `${import.meta.env.BASE_URL}${value.replace(/^\.?\//, "")}`;
}

export const CHARACTER_MODEL_URL = configured
  ? resolve(configured)
  : `${import.meta.env.BASE_URL}models/character.sample.vrm`;

export const HAS_CUSTOM_CHARACTER_MODEL = configured.length > 0;