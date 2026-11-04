/**
 * 账单定时任务：
 *   - 将逾期 3 天以上的 pending 账单标记为 overdue
 *   - 为开启自动续费、7 天内到期的付费租户生成续费账单
 *
 * manual / mock 模式只生成账单，不自动扣款；
 * 接入真实支付网关后，在此调用扣款或等待网关回调。
 */
import { closePool } from '../src/db';
import {
  createRenewalInvoices,
  markOverdueInvoices,
  paymentProvider,
} from '../src/services/billing';

async function main() {
  const overdue = await markOverdueInvoices();
  const renewals = await createRenewalInvoices();
  console.log(
    `[billing] provider=${paymentProvider()} overdue_marked=${overdue} renewals_created=${renewals.length}`,
  );
  for (const invoice of renewals) {
    console.log(
      `[billing] ${invoice.invoice_no} org=${invoice.org_id} ${invoice.plan}/${invoice.cycle} amount=${invoice.amount}`,
    );
  }
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closePool();
  });
