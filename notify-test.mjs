// Sends one fake arrival through every channel configured in .env, with the same options
// the server uses, then prints each channel's result. Usage: npm run notify:test
import { EventHub, Notifier, notifierOptionsFromEnv } from './src/notifier.mjs';

const notifier = new Notifier({ hub: new EventHub(), ...notifierOptionsFromEnv(process.env), maxAttempts: 1 });
if (!notifier.channels.length) {
  console.error('.env 里没有配置任何推送渠道（BARK_URL、FEISHU_WEBHOOK_URL 等）');
  process.exit(1);
}

notifier.send({
  id: `test-${Date.now()}`,
  sessionId: 'notify-test',
  productName: 'iPhone 18 Pro Max',
  capacity: '256GB',
  colorLabel: '测试',
  storeName: '三里屯（这是测试消息）',
  appleUrl: 'https://www.apple.com.cn/'
});

const timer = setInterval(() => {
  if (notifier.pending().length) return;
  clearInterval(timer);
  const channels = notifier.snapshot().channels;
  for (const channel of channels) {
    console.log(channel.sent ? `✓ ${channel.name} 已发送` : `✗ ${channel.name} 失败：${channel.lastError}`);
  }
  process.exit(channels.every(channel => channel.sent) ? 0 : 1);
}, 200);
