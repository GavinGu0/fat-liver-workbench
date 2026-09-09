import { CLIENT_SALT } from '@flwb/shared';

/** 与服务端约定：sha256(password + '::' + CLIENT_SALT) 后传输，服务端 bcrypt 存储 */
export async function hashPassword(pwd) {
  const data = new TextEncoder().encode(`${pwd}::${CLIENT_SALT}`);
  const buf = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
