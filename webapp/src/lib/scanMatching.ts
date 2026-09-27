interface ClientRecord { name: string }
interface ProductRecord { clientName: string; productName: string; productNumber: string }

function companyKey(s: string): string {
  return s.normalize("NFKC").toLowerCase()
    .replace(/株式会社|\(株\)|合同会社|有限会社|\(有\)/g, "")
    .replace(/[／/\s()【】\[\]・,，。.\-－]/g, "");
}

export function findClientMatch<T extends ClientRecord>(clients: T[], name: string): T | undefined {
  const key = companyKey(name);
  if (!key) return undefined;
  const exact = clients.filter(c => companyKey(c.name) === key);
  if (exact.length) return exact.length === 1 ? exact[0] : undefined;
  const withoutDepartment = (s: string) => companyKey(s.normalize("NFKC").replace(/\s+[^\s]+(?:課|部|事業所|営業所|工場)$/, ""));
  const base = withoutDepartment(name);
  const departments = clients.filter(c => !!base && withoutDepartment(c.name) === base);
  if (departments.length) return departments.length === 1 ? departments[0] : undefined;
  // Other longer partial names must also identify one unambiguous client.
  const candidates = clients.filter(c => {
    const other = companyKey(c.name);
    return Math.min(key.length, other.length) >= 4 && (key.includes(other) || other.includes(key));
  });
  return candidates.length === 1 ? candidates[0] : undefined;
}

export function findProductMatch<T extends ProductRecord>(products: T[], client: string, productName: string, productNumber: string): T | undefined {
  const code = (s: string) => s.normalize("NFKC").replace(/[‐‑–—−]/g, "-").replace(/\s/g, "").toUpperCase();
  const name = (s: string) => s.normalize("NFKC").replace(/\s/g, "");
  const candidates = products.filter(p => !!companyKey(client) && companyKey(p.clientName) === companyKey(client));
  // A scanned drawing number must agree. A common name such as タンク is not
  // sufficient to override a different drawing number or another client's item.
  const matches = productNumber.trim()
    ? candidates.filter(p => code(p.productNumber) === code(productNumber))
    : candidates.filter(p => !!productName.trim() && name(p.productName) === name(productName));
  return matches.length === 1 ? matches[0] : undefined;
}
