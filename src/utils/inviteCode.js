// 'MESS-4F7K' style codes -- excludes visually-ambiguous chars (0/O, 1/I/L).
const ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';

export function generateInviteCode() {
  let code = '';
  for (let i = 0; i < 4; i++) {
    code += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
  }
  return `MESS-${code}`;
}
