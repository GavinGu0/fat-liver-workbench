'use strict';
/** Swagger UI（CDN 版）：生产环境默认关闭，ENABLE_API_DOCS=true 开启 */
const { defineHandler } = require('./_lib/handler');

module.exports = defineHandler({
  auth: 'public',
  fn: async () => {
    const enabled = process.env.ENABLE_API_DOCS === 'true' || process.env.NODE_ENV !== 'production';
    const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8"/>
<title>脂肪肝专病管理工作台 · API 文档</title>
<link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist@5/swagger-ui.css"/>
</head>
<body>
<div id="swagger"></div>
<script src="https://unpkg.com/swagger-ui-dist@5/swagger-ui-bundle.js"></script>
<script>
window.SwaggerUIBundle({ url: '/api/openapi.json', dom_id: '#swagger', persistAuthorization: true });
</script>
</body>
</html>`;
    return { __html: enabled ? html : '<h2>接口文档已关闭（设置环境变量 ENABLE_API_DOCS=true 开启）</h2>' };
  }
});
