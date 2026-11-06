import { createHmac, timingSafeEqual } from 'node:crypto';
export function signContact(id: string, secret: string) { return createHmac('sha256',secret).update(id).digest('hex'); }
export function verifyContact(id: string, token: string, secret: string) {
 if (!/^[a-f0-9]{64}$/.test(token)) return false;
 return timingSafeEqual(Buffer.from(token,'hex'),Buffer.from(signContact(id,secret),'hex'));
}
export function escapeHtml(value: string) { return value.replace(/[&<>"']/g,c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!)); }
export function merge(content: string, values: Record<string,unknown>, html = true) {
 return content.replace(/{{\s*([a-zA-Z0-9_]+)\s*}}/g,(_,key: string) => {
  const value = String(values[key] ?? ''); return html ? escapeHtml(value) : value.replace(/[\r\n]/g,' ');
 });
}
