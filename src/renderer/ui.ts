import type { CSSProperties } from 'react'

export const colors = {
  bg: '#1a1b1e',
  panel: '#26282c',
  panel2: '#1f2023',
  border: '#33363b',
  text: '#e6e6e6',
  muted: '#9aa0aa',
  accent: '#3b82f6',
  green: '#22c55e',
  red: '#ef4444',
  amber: '#f59e0b',
}

export const card: CSSProperties = {
  background: colors.panel,
  border: `1px solid ${colors.border}`,
  borderRadius: 8,
  padding: 16,
}

export const button: CSSProperties = {
  padding: '8px 14px',
  background: colors.accent,
  color: '#fff',
  border: 'none',
  borderRadius: 6,
  cursor: 'pointer',
  fontSize: 13,
}

export const buttonGhost: CSSProperties = {
  ...button,
  background: 'transparent',
  border: `1px solid ${colors.border}`,
  color: colors.text,
}

export const input: CSSProperties = {
  background: colors.panel2,
  color: colors.text,
  border: `1px solid ${colors.border}`,
  borderRadius: 6,
  padding: '8px 10px',
  width: '100%',
  fontSize: 13,
  boxSizing: 'border-box',
}

export const label: CSSProperties = { fontSize: 12, color: colors.muted, display: 'block', marginBottom: 4 }

/** 작업/프로젝트 상태 → 색상. */
export function statusColor(status: string): string {
  switch (status) {
    case 'done':
      return colors.green
    case 'failed':
      return colors.red
    case 'running':
    case 'review':
    case 'executing':
    case 'verifying':
      return colors.amber
    default:
      return colors.muted
  }
}
