/**
 * ============================================================================
 *  /s/<token> —— 加密分享路由（卡密资源分发系统 v1.0.4）
 * ============================================================================
 *  统一分享/下载入口（URL 中看不到真实文件路径，且自带卡密）：
 *    · 提取页 token：GET /s/<token> → 返回提取页整页，页面 JS 用 token 自动
 *      核销（买家免输入卡密/提取码）
 *    · 下载 token：GET /s/<token> → 校验卡密状态后下发 R2 资源 / 302 到外链
 *
 *  本文件是薄包装：把 /s/* 的 catch-all 参数拼上 's' 前缀后，
 *  复用 functions/api/[[path]].js 的完整路由器（pathParts[0] === 's' 分支）。
 *  Pages 仅对 /s/* 计入 Functions 调用，静态资源不受影响。
 * ============================================================================
 */
import { onRequest as mainOnRequest } from '../api/[[path]].js';

export async function onRequest(context) {
  const p = context.params && context.params.path;
  const parts = Array.isArray(p) ? p : p ? [p] : [];
  context.params = { path: ['s', ...parts] };
  return mainOnRequest(context);
}
