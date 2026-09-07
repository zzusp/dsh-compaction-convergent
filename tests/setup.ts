import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import type { Context } from '@deepseek-ai/cordis'

export function installTokenMeter(ctx: Context): TokenMeter {
  void new SessionProjectionRegistry(ctx)
  return new TokenMeter(ctx)
}
