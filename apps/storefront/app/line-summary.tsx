import { formatPrice } from "@/lib/money";

export interface SummaryLine {
  productId: string;
  name: string;
  quantity: number;
  lineTotalMinor: number;
}

/** "2 × Notebook Set — $24.00" lines, shared by the Checkout and Order pages. */
export function LineSummary({ lines, currency }: { lines: SummaryLine[]; currency: string }) {
  return (
    <ul className="summary">
      {lines.map((line) => (
        <li key={line.productId}>
          {line.quantity} × {line.name} — {formatPrice(line.lineTotalMinor, currency)}
        </li>
      ))}
    </ul>
  );
}
