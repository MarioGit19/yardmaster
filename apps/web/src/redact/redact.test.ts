import { describe, expect, it } from 'vitest';
import { MASK, redact, redactDeep, StreamRedactor } from './redact.js';

// Fake secrets are assembled at runtime so no secret-shaped literal sits in the repo.
const ANTHROPIC = `${'sk-'}ant-api03-${'Zx9'.repeat(10)}_AbC-dEf`;
const GITHUB = `${'gh'}p_${'aB3dE6gH9j'.repeat(4)}`;
const GITHUB_PAT = `${'github'}_pat_11ABCDEFG0_${'xYz12'.repeat(8)}`;
const AWS = `${'AK'}IA${'Q7Z3WXYV2PLM5N8R'}`;
const PEM_BODY = ['MIIEvQIBADANBgkqhkiG9w0BAQEFAASC', 'BKcwggSjAgEAAoIBAQC7', 'q3J9'];
const BEGIN = `-----${'BEGIN'} RSA PRIVATE KEY-----`;
const END = `-----${'END'} RSA PRIVATE KEY-----`;
const PEM = [BEGIN, ...PEM_BODY, END].join('\n');

describe('redact: token patterns', () => {
  it('masks Anthropic keys and keeps the prefix', () => {
    expect(redact(`key is ${ANTHROPIC} ok`)).toBe(`key is sk-ant-${MASK} ok`);
  });

  it('masks GitHub tokens, all prefixes and fine-grained PATs', () => {
    expect(redact(GITHUB)).toBe(`ghp_${MASK}`);
    expect(redact(GITHUB.replace('ghp_', 'gho_'))).toBe(`gho_${MASK}`);
    expect(redact(GITHUB.replace('ghp_', 'ghs_'))).toBe(`ghs_${MASK}`);
    expect(redact(`token: ${GITHUB_PAT}`)).toBe(`token: github_pat_${MASK}`);
  });

  it('masks AWS access key ids', () => {
    expect(redact(`aws_access_key_id = ${AWS}`)).toBe(`aws_access_key_id = AKIA${MASK}`);
    expect(redact(AWS.replace('AKIA', 'ASIA'))).toBe(`ASIA${MASK}`);
  });

  it('masks every secret on a line, and many lines', () => {
    const text = `${GITHUB} and ${ANTHROPIC}\nthen ${AWS}`;
    expect(redact(text)).toBe(`ghp_${MASK} and sk-ant-${MASK}\nthen AKIA${MASK}`);
  });
});

describe('redact: key blocks', () => {
  it('masks the body of a PEM key and keeps the markers and rows', () => {
    expect(redact(`before\n${PEM}\nafter`)).toBe(
      `before\n${BEGIN}\n${MASK}\n${MASK}\n${MASK}\n${END}\nafter`,
    );
  });

  it('masks other key kinds', () => {
    const begin = `-----${'BEGIN'} OPENSSH PRIVATE KEY-----`;
    const end = `-----${'END'} OPENSSH PRIVATE KEY-----`;
    expect(redact(`${begin}\nb3BlbnNzaC1rZXk\n${end}`)).toBe(`${begin}\n${MASK}\n${end}`);
  });

  it('masks an unterminated block to the end', () => {
    expect(redact(`${BEGIN}\n${PEM_BODY[0]}\n${PEM_BODY[1]}`)).toBe(`${BEGIN}\n${MASK}\n${MASK}`);
  });

  it('keeps CRLF line breaks', () => {
    expect(redact(`${BEGIN}\r\nabc\r\n${END}`)).toBe(`${BEGIN}\r\n${MASK}\r\n${END}`);
  });
});

describe('redact: .env assignments', () => {
  it('masks values of secret-ish names', () => {
    expect(redact('API_KEY=abc123')).toBe(`API_KEY=${MASK}`);
    expect(redact('export DB_PASSWORD=hunter2')).toBe(`export DB_PASSWORD=${MASK}`);
    expect(redact('STRIPE_SECRET=whsec_x9')).toBe(`STRIPE_SECRET=${MASK}`);
    expect(redact('SLACK_TOKEN = "xo-12 34"')).toBe(`SLACK_TOKEN = "${MASK}"`);
    expect(redact("SECRET_KEY_BASE='a1b2'")).toBe(`SECRET_KEY_BASE='${MASK}'`);
    expect(redact('OPENAIKEY=v')).toBe(`OPENAIKEY=${MASK}`);
  });

  it('masks each line of a .env file', () => {
    const env = 'NODE_ENV=production\nAUTH_TOKEN=t0k3n\nPORT=3000\nSMTP_PASSWD=pw';
    expect(redact(env)).toBe(
      `NODE_ENV=production\nAUTH_TOKEN=${MASK}\nPORT=3000\nSMTP_PASSWD=${MASK}`,
    );
  });

  it('leaves names that only contain the word inside a segment', () => {
    for (const line of ['KEYBOARD_LAYOUT=us', 'MAX_TOKENS=4096', 'TOKENIZER=bpe', 'KEYS=3']) {
      expect(redact(line)).toBe(line);
    }
  });

  it('leaves empty values, references, comparisons and lowercase code', () => {
    for (const line of [
      'API_KEY=',
      'API_KEY=""',
      'API_KEY=$API_KEY',
      `API_KEY="\${API_KEY}"`,
      'if [ "$X" == "y" ]; then API_KEY==1; fi',
      'const apiKey = getKey();',
      'password=hunter2',
    ]) {
      expect(redact(line)).toBe(line);
    }
  });

  it('stops at an escape sequence, so terminal colors survive', () => {
    expect(redact('API_KEY=abc\x1b[0m')).toBe(`API_KEY=${MASK}\x1b[0m`);
  });
});

describe('redact: no false positives', () => {
  const ordinary = [
    'commit 3f786850e387550fdab836ed7e6dc881de23001b',
    'sha256:9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08',
    'id 123e4567-e89b-12d3-a456-426614174000',
    'session 6F9619FF-8B86-D011-B42D-00C04FC964FF',
    'integrity sha512-z4PhNX7vuL3xVChQ1m2AB9Yg5AULVxXcg/SpIdNs6c5H0NE8XYXysP+DGNKHfuwvY7kxvUdBeoGlODJ6+SfaPg==',
    'base64 aGVsbG8gd29ybGQgdGhpcyBpcyBhIHRlc3Q=',
    'AKIA is the prefix of an access key id',
    'the sk-ant- prefix, ghp_ prefix and AKIA prefix',
    'risk-ant-colony-optimisation',
    'path /home/dev/acme-shop/src/keys/index.ts',
    '-----BEGIN CERTIFICATE-----',
    '',
  ];
  it.each(ordinary)('leaves %s', (text) => {
    expect(redact(text)).toBe(text);
  });

  it('returns the same string when nothing matched', () => {
    const text = 'plain output';
    expect(redact(text)).toBe(text);
  });
});

describe('redactDeep', () => {
  it('masks nested strings', () => {
    const input = { command: `curl -H "Authorization: token ${GITHUB}"`, env: ['A=1', `B=${AWS}`] };
    expect(redactDeep(input)).toEqual({
      command: `curl -H "Authorization: token ghp_${MASK}"`,
      env: ['A=1', `B=AKIA${MASK}`],
    });
  });

  it('keeps identity when nothing changed', () => {
    const input = { file_path: '/home/dev/acme-shop/a.ts', edits: [{ old_string: 'a' }], n: 3 };
    expect(redactDeep(input)).toBe(input);
    expect(redactDeep(null)).toBe(null);
  });
});

describe('StreamRedactor', () => {
  const run = (chunks: string[]) => {
    const r = new StreamRedactor();
    return chunks.map((c) => r.push(c)).join('') + r.flush();
  };

  it('masks a secret split across chunks', () => {
    const half = Math.floor(ANTHROPIC.length / 2);
    expect(run([`token ${ANTHROPIC.slice(0, half)}`, `${ANTHROPIC.slice(half)}\r\n`])).toBe(
      `token sk-ant-${MASK}\r\n`,
    );
  });

  it('holds only the unfinished line', () => {
    const r = new StreamRedactor();
    expect(r.push('one\r\ntw')).toBe('one\r\n');
    expect(r.pending).toBe(true);
    expect(r.flush()).toBe('tw');
    expect(r.pending).toBe(false);
  });

  it('passes carriage-return progress through', () => {
    const r = new StreamRedactor();
    expect(r.push('\r 40%\r')).toBe('\r 40%\r');
  });

  it('masks a key block across chunks until its END line', () => {
    const r = new StreamRedactor();
    const out = [
      r.push(`${BEGIN}\r\n${PEM_BODY[0]}\r\n`),
      r.push(`${PEM_BODY[1]}\r\n`),
      r.push(`${PEM_BODY[2]}\r\n${END}\r\n${GITHUB}\r\n`),
      r.push('done\r\n'),
    ].join('');
    expect(out).toBe(
      `${BEGIN}\r\n${MASK}\r\n${MASK}\r\n${MASK}\r\n${END}\r\nghp_${MASK}\r\ndone\r\n`,
    );
  });

  it('matches redact() for whole text, however it is chunked', () => {
    const text = `a ${GITHUB}\nAPI_KEY=xyz\n${PEM}\nb ${AWS}\n`;
    const whole = redact(text);
    for (const size of [1, 3, 7, 64]) {
      const chunks: string[] = [];
      for (let i = 0; i < text.length; i += size) chunks.push(text.slice(i, i + size));
      expect(run(chunks)).toBe(whole);
    }
  });

  it('never holds a line without breaks forever', () => {
    const r = new StreamRedactor();
    expect(r.push('x'.repeat(5_000))).toHaveLength(5_000);
  });
});
