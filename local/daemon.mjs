/**
 * ============================================================================
 *  卡密资源分发系统 v1.0.3 —— 沙盒持久化启动器（setsid + 双 fork 孤儿进程）
 * ============================================================================
 *  用法（在仓库根目录执行）：
 *      setsid node local/daemon.mjs
 *
 *  原理：
 *    1) setsid 让首进程脱离当前会话（无控制终端）；
 *    2) daemon.mjs 内部连续 fork 两次（每次 detached + unref + 父进程立即退出），
 *       最终孙进程彻底脱离工具进程树，成为 1 号收养的孤儿进程，持久运行；
 *    3) 日志写入仓库根目录 dev-server.log。
 *
 *  停止：pkill -f dev-server.mjs
 * ============================================================================
 */

import { fork } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const LOG_FILE = path.join(ROOT, 'dev-server.log');
const stage = Number(process.env.CARD_DAEMON_STAGE || 0);

if (stage < 2) {
  // 第 1 / 第 2 次 fork：完全脱离父进程后立即退出
  const child = fork(import.meta.filename, [], {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, CARD_DAEMON_STAGE: String(stage + 1) },
  });
  child.unref();
  process.exit(0);
}

// 最终孙进程：日志重定向到文件后启动真正的服务
const logFd = fs.openSync(LOG_FILE, 'a');
const child = fork(path.join(__dirname, 'dev-server.mjs'), [], {
  detached: true,
  stdio: ['ignore', logFd, logFd, 'ipc'], // fork 必须保留 ipc 通道
  env: process.env,
});
child.unref();
child.on('exit', (code) => {
  try {
    fs.appendFileSync(LOG_FILE, `[daemon] dev-server 退出 code=${code} ${new Date().toISOString()}\n`);
  } catch {}
});

// 父进程退出，孙进程继续运行
setTimeout(() => process.exit(0), 300);
