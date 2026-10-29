// ============================================================================
// 卡密资源分发系统 v1.0.4 —— 部署配置（.github/workflows/pages-deploy.yml 由此读取）
// ============================================================================
// 使用 GitHub 自动部署前，在仓库 Settings → Secrets and variables → Actions
// 配置以下 Secrets（均只需配置一次，之后 push main 即自动发布到 Cloudflare Pages）:
//
//   CLOUDFLARE_API_TOKEN   必填。Cloudflare API Token
//                          模板「Edit Cloudflare Workers」+ 追加权限:
//                          Account → Cloudflare Pages → Edit
//                          Account → D1           → Edit
//                          Account → Workers R2 Storage → Edit
//   ADMIN_SECRET           必填。管理面板登录密钥（长随机字符串）。
//                          CI 会自动把它写入 Pages 运行环境 Secret，
//                          等价于在 Pages 控制台手工配置 ADMIN_SECRET
//   ISSUE_APIKEY           可选。旧版单密钥；建议改用管理面板
//                          「APIKEY 管理」创建多把可区分调用方的 key
//   CLOUDFLARE_ACCOUNT_ID  可选。账号 ID；Token 只关联一个账号时可留空
// ============================================================================
export default {
  // Cloudflare Pages 项目名（首次运行时自动创建）
  projectName: 'cards-download',

  // D1 数据库名（留空 = 不创建 / 不绑定 D1）
  d1Name: 'cards-download',

  // R2 存储桶名（留空 = 不创建 / 不绑定 R2，资源上传功能不可用）
  r2Name: 'cards-download-scripts',

  // 账号 ID（留空自动探测）
  accountId: '',
};
