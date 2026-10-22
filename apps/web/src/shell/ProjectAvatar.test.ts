import { describe, expect, it } from 'vitest';
import { projectInitial } from './ProjectAvatar.js';

describe('projectInitial', () => {
  it('takes the first letter, uppercased', () => {
    expect(projectInitial('acme-shop')).toBe('A');
    expect(projectInitial('  x ')).toBe('X');
    expect(projectInitial('Đặng-Thị-Ngọc-Hân-portfolio')).toBe('Đ');
    expect(projectInitial('東京オフィス')).toBe('東');
    expect(projectInitial('42-tools')).toBe('4');
  });

  it('skips emoji instead of splitting them', () => {
    expect(projectInitial('👩🏽‍💻 portfolio')).toBe('P');
    expect(projectInitial('🦊')).toBe('🦊');
    expect(projectInitial('👩🏽‍💻')).toBe('👩🏽‍💻');
  });

  it('falls back for an empty name', () => {
    expect(projectInitial('   ')).toBe('?');
  });
});
