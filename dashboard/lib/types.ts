// Shapes from contracts/api.md + contracts/fixtures/*.json (the `data` object of each response).
// Every key in a fixture is always present (it may be 0 or null).

export type LineState = 'ok' | 'near' | 'over';

export interface SummaryLine {
  category_key: string;
  label: string;
  planned_cad: number;
  actual_cad: number;
  pending_cad: number;
  remaining_cad: number;
  over_cad: number;
  pct_used: number;
  state: LineState;
  projected_actual_cad: number;
  projected_under_cad: number;
}

export interface Summary {
  user_id: string;
  name: string;
  status: 'active' | 'paused';
  demo_mode: boolean;
  as_of: string;
  week: { week_start: string; week_end: string; days_left: number; next_audit_at: string };
  lines: SummaryLine[];
  totals: { planned_cad: number; actual_cad: number; remaining_cad: number; over_cad: number; projected_leftover_cad: number };
  buffer: { balance_cad: number; target_cad: number; cushion_rate: number; absorb_overspend: boolean };
  lifetime: { invested_cad: number; weeks_invested: number; weeks_audited: number };
  last_audit: { audit_id: string; week_start: string; status: AuditStatus; investable_cad: number } | null;
  portfolio: { market_value_usd: number; market_value_cad: number; fx_rate_usdcad: number; queued_usd: number };
}

export type AuditStatus = 'computed' | 'invested' | 'carried' | 'skipped_paused';

export interface AuditLine {
  category_key: string;
  label: string;
  planned_cad: number;
  actual_cad: number;
  under_cad: number;
  over_cad: number;
}

export interface Audit {
  audit_id: string;
  week_start: string;
  week_end: string;
  status: AuditStatus;
  gross_surplus_cad: number;
  total_over_cad: number;
  late_adj_cad: number;
  to_buffer_cad: number;
  buffer_after_cad: number;
  investable_cad: number;
  pending_carry_after_cad: number;
  best_category: { category_key: string; label: string; under_cad: number } | null;
  lines: AuditLine[];
}

export interface Streak {
  category_key: string;
  label: string;
  weeks_under: number;
  weeks_total: number;
  current_streak: number;
}

export interface Audits {
  user_id: string;
  audits: Audit[];
  totals: { gross_surplus_cad: number; to_buffer_cad: number; invested_cad: number; weeks_audited: number; weeks_invested: number };
  streaks: Streak[];
}

export type OrderStatus = 'queued' | 'partially_filled' | 'filled' | 'rejected' | 'canceled' | 'dry_run';

export interface Position {
  symbol: string;
  sleeve: string;
  qty: number;
  current_price_usd: number;
  market_value_usd: number;
  market_value_cad: number;
  cost_basis_usd: number;
  contributed_cad: number;
  unrealized_pl_usd: number;
}

export interface Order {
  client_order_id: string;
  audit_id: string;
  week_start: string;
  symbol: string;
  sleeve: string;
  notional_cad: number;
  notional_usd: number;
  fx_rate: number;
  status: OrderStatus;
  alpaca_status: string;
  filled_qty: number;
  filled_avg_price: number;
  estimated_value_usd: number | null;
  submitted_at: string;
  filled_at: string | null;
}

export interface Portfolio {
  user_id: string;
  as_of: string;
  fx_rate_usdcad: number;
  fx_source: string;
  /** null when Alpaca isn't reachable (no clock) */
  market_open: boolean | null;
  next_open: string | null;
  totals: {
    contributed_cad: number;
    cost_basis_usd: number;
    market_value_usd: number;
    market_value_cad: number;
    unrealized_pl_usd: number;
    unrealized_pl_pct: number;
    queued_usd: number;
  };
  positions: Position[];
  orders: Order[];
}

export interface FvPoint {
  years: number;
  value_cad: number;
}

export interface Projection {
  user_id: string;
  selected_rate: number;
  rates: number[];
  horizons_years: number[];
  disclaimer: string;
  lifetime: { contributed_cad: number; weeks_invested: number; weekly_average_cad: number; by_rate: Record<string, FvPoint[]> };
  last_week: { audit_id: string; invested_cad: number; by_rate: Record<string, FvPoint[]> } | null;
  your_choices: {
    category_key: string;
    label: string;
    weeks_under: number;
    weeks_total: number;
    leftover_cad: number;
    fv_30y_cad: Record<string, number>;
  }[];
}

export interface BudgetSetting {
  category_key: string;
  label: string;
  weekly_amount_cad: number;
  active: boolean;
}

export interface Settings {
  user_id: string;
  status: 'active' | 'paused';
  buffer_target_cad: number;
  cushion_rate: number;
  absorb_overspend: boolean;
  min_invest_cad: number;
  max_weekly_invest_cad: number;
  onboarding_url: string;
  budgets: BudgetSetting[];
}

/** Body of POST /lo/api/settings (contracts/webhooks.md), minus user_id. */
export interface SettingsUpdate {
  status?: 'active' | 'paused';
  buffer_target?: number;
  cushion_rate?: number;
  absorb_overspend?: boolean;
  budgets?: { category_key: string; weekly_amount: number; active?: boolean }[];
}

/** Where a page's data came from. Mock data always shows a visible badge. */
export type Source =
  | { kind: 'live' }
  | { kind: 'mock'; reason: 'mock-mode' | 'unreachable' | 'error' | 'shape'; detail: string };

export interface Loaded<T> {
  data: T;
  source: Source;
}

/** What the demo bar / settings routes return to the browser. */
export interface ActionResult {
  ok: boolean;
  /** true when nothing changed: MOCK=1, or a step that took its fallback */
  simulated: boolean;
  message: string;
  /** the digest email, shown as a preview */
  email?: { subject: string; body: string };
  /** offer the manual-expense fallback (spec §15 backup) */
  offerManual?: boolean;
  raw?: unknown;
}
