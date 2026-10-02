// PHANTOM BEATS PWA 本地 HTTPS 服务器
// 用法：node serve-https.js   然后手机连同一 WiFi，浏览器打开 https://<本机局域网IP>:8443
// 注意：自签证书会被 Chrome 报"不安全"，点「高级 → 继续访问」即可（仍属安全上下文，可安装 PWA）
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = __dirname;
const PORT = 8443;
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.pem': 'application/x-pem-file'
};

const server = https.createServer(
  {
    key: fs.readFileSync(path.join(ROOT, 'key.pem')),
    cert: fs.readFileSync(path.join(ROOT, 'cert.pem'))
  },
  (req, res) => {
    let urlPath = decodeURIComponent(req.url.split('?')[0]);
    if (urlPath === '/') urlPath = '/index.html';
    const file = path.join(ROOT, path.normalize(urlPath).replace(/^(\.\.[/\\])+/, ''));
    if (!file.startsWith(ROOT)) { res.writeHead(403); return res.end('forbidden'); }
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404); return res.end('not found: ' + urlPath); }
      const ext = path.extname(file).toLowerCase();
      res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
      res.end(data);
    });
  }
);

function lanIPs() {
  const list = [];
  const ifaces = os.networkInterfaces();
  for (const name in ifaces) for (const ni of ifaces[name]) {
    if (ni.family === 'IPv4' && !ni.internal) list.push(ni.address);
  }
  return list;
}

server.listen(PORT, '0.0.0.0', () => {
  console.log('PHANTOM BEATS PWA 已启动 (HTTPS)');
  console.log('本机访问:   https://localhost:' + PORT);
  const ips = lanIPs();
  if (ips.length) {
    console.log('手机访问（同一 WiFi）:');
    ips.forEach((ip) => console.log('   https://' + ip + ':' + PORT));
  } else {
    console.log('⚠ 未检测到局域网 IP，手机可能无法访问');
  }
  console.log('在手机 Chrome 打开后 → 菜单「添加到主屏幕」即可安装为 App');
});
