export function formatPrice(priceMinor: number, currency: string): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(priceMinor / 100);
}
