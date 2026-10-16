// Classify the page shown at a store entry without treating HTTP 200 as proof that sales are open.
export function classifyStoreEntry({ pathname, text, ready, productPage = false }) {
  if (ready) return 'ready';
  if (/\/shop\/(?:signIn|login)(?:\/|$)/i.test(pathname)) return 'login';
  if (/我们马上回来|马上回来|we\s+can['’]t\s+wait\s+either|we['’]ll\s+be\s+right\s+back/i.test(text)) {
    return 'waiting';
  }
  if (productPage && /\d{1,2}\s*月\s*\d{1,2}\s*日.{0,16}(?:接受预购|开始预购)/.test(text)) {
    return 'waiting';
  }
  return 'unexpected';
}
