export class Calc {
  factor: number;
  constructor(factor: number) {
    this.factor = factor;
  }
  scale(n: number): number {
    return n * this.factor;
  }
}

export const sum = ({ a, b }: { a: number; b: number }) => a + b;

export async function loadName(id: number): Promise<string> {
  await new Promise((r) => setTimeout(r, 2));
  return `user${id}`;
}

export async function greet(id: number) {
  const name = await loadName(id);
  return `hello ${name}`;
}

export function risky(n: number) {
  if (n > 1) throw new Error(`too big: ${n}`);
  return n;
}

export async function runJob(n: number) {
  return risky(n);
}
