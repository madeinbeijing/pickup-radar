export function validatePlan(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('方案必须是 JSON 对象');
  const { productUrl, modelName, color, capacities, storeCandidates, payment, expectedTotalCny, maxTotalCny } = input;
  let url;
  try { url = new URL(productUrl); } catch { throw new Error('productUrl 不是有效网址'); }
  if (url.protocol !== 'https:' || url.hostname !== 'www.apple.com.cn' ||
      !/^\/shop\/buy-iphone\/[a-z0-9-]+\/?$/.test(url.pathname) || url.search || url.hash) {
    throw new Error('productUrl 必须是 Apple 中国官网的 iPhone 选购首页');
  }
  if (typeof modelName !== 'string' || !/^iPhone [\w ]{1,35}$/.test(modelName)) throw new Error('机型名称无效');
  if (typeof color !== 'string' || !color.trim() || color.length > 20) throw new Error('颜色无效');
  if (!Array.isArray(capacities) || capacities.length !== 2 ||
      capacities.some(v => typeof v !== 'string' || !/^(?:\d{2,4}GB|[1-9]TB)$/.test(v))) {
    throw new Error('capacities 必须准确写出两台设备的容量');
  }
  if (!Array.isArray(storeCandidates) || storeCandidates.length < 1 || storeCandidates.length > 10 ||
      storeCandidates.some(v => typeof v !== 'string' || !/^Apple [^\n]{2,30}$/.test(v))) {
    throw new Error('请按优先顺序列出 Apple 零售店');
  }
  if (!['支付宝', '微信支付'].includes(payment)) throw new Error('当前脚本仅支持已实测的支付宝或微信支付选项');
  if (!Number.isSafeInteger(maxTotalCny) || maxTotalCny < 1 || maxTotalCny > 100000) {
    throw new Error('maxTotalCny 必须是合理的正整数');
  }
  if (!Number.isSafeInteger(expectedTotalCny) || expectedTotalCny < 1 || expectedTotalCny > maxTotalCny) {
    throw new Error('expectedTotalCny 必须准确匹配两台设备的价格，且不超过上限');
  }
  return { productUrl: url.href, modelName, color, capacities: [...capacities],
    storeCandidates: [...storeCandidates], payment, expectedTotalCny, maxTotalCny };
}

export function expectedLines(plan) {
  const counts = new Map();
  for (const capacity of plan.capacities) counts.set(capacity, (counts.get(capacity) ?? 0) + 1);
  return [...counts].map(([capacity, quantity]) => ({
    title: `${plan.modelName} ${capacity} ${plan.color}`, capacity, quantity
  }));
}

export function parseCny(text) {
  const match = text.match(/RMB\s*([\d,]+)/);
  if (!match) throw new Error('无法核对购物袋金额');
  const value = Number(match[1].replaceAll(',', ''));
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error('购物袋金额无效');
  return value;
}

export function assertReview(review, plan) {
  const expected = expectedLines(plan);
  if (review.lines?.length !== expected.length ||
      expected.some((line, i) => review.lines[i]?.title !== line.title || review.lines[i]?.quantity !== line.quantity) ||
      review.invoice !== '电子发票 - 个人' || review.payment !== plan.payment ||
      review.total !== plan.expectedTotalCny || review.total > plan.maxTotalCny || !review.finalButton) {
    throw new Error('订单检查页与方案不一致；已停止，未点击最终下单按钮');
  }
}
