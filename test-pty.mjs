import * as pty from 'node-pty';
import * as os from 'os';

const shell = process.env.COMSPEC || 'cmd.exe';
const term = pty.spawn(shell, [], {
  name: 'xterm-256color',
  cols: 80,
  rows: 24,
  cwd: process.cwd(),
  env: { ...process.env, TERM: 'xterm-256color' }
});

let output = '';
let opencodeStarted = false;

term.onData((data) => {
  process.stdout.write(data);
  output += data;

  // 检测 opencode 是否启动了
  if (output.includes('opencode') || output.includes('OpenCode') || output.includes('opencode>')) {
    if (!opencodeStarted) {
      opencodeStarted = true;
      console.log('\n--- opencode 已启动，输出正常 ---');
    }
  }
});

// 启动 opencode
setTimeout(() => {
  term.write('opencode\r');
}, 500);

// 跑 10 秒后退出
setTimeout(() => {
  console.log('\n--- 测试完成 ---');
  console.log(`收到 ${output.length} 字符`);
  process.exit(0);
}, 10000);
