// 精确有理数：BigInt 分子/分母，永不提前四舍五入。
export class Fraction {
  readonly num: bigint;
  readonly den: bigint;

  private constructor(num: bigint, den: bigint) {
    if (den === 0n) throw new Error("分母为零");
    if (den < 0n) { num = -num; den = -den; }
    const g = gcd(num < 0n ? -num : num, den);
    this.num = num / g;
    this.den = den / g;
  }

  static of(num: bigint, den: bigint = 1n): Fraction {
    return new Fraction(num, den);
  }

  static zero(): Fraction {
    return new Fraction(0n, 1n);
  }

  // 解析最多六位小数的非负十进制字符串，如 "123.456789"
  static parseDecimal(s: string): Fraction | null {
    if (!/^\d+(\.\d{1,6})?$/.test(s)) return null;
    const [intPart, fracPart = ""] = s.split(".");
    const den = 10n ** BigInt(fracPart.length);
    const num = BigInt(intPart) * den + BigInt(fracPart === "" ? "0" : fracPart);
    return new Fraction(num, den);
  }

  static isValidDecimalString(s: unknown): s is string {
    return typeof s === "string" && /^\d+(\.\d{1,6})?$/.test(s);
  }

  add(o: Fraction): Fraction {
    return new Fraction(this.num * o.den + o.num * this.den, this.den * o.den);
  }

  mul(o: Fraction): Fraction {
    return new Fraction(this.num * o.num, this.den * o.den);
  }

  div(o: Fraction): Fraction {
    if (o.num === 0n) throw new Error("除以零");
    return new Fraction(this.num * o.den, this.den * o.num);
  }

  isZero(): boolean { return this.num === 0n; }
  isPositive(): boolean { return this.num > 0n; }

  // 精确分数字符串，如 "2/3"；整数则只显示整数
  toString(): string {
    return this.den === 1n ? this.num.toString() : `${this.num}/${this.den}`;
  }

  // 固定小数展示（仅用于显示，不参与后续计算）
  toFixed(places: number): string {
    const scale = 10n ** BigInt(places);
    const scaled = (this.num * scale) / this.den; // 截断
    const intPart = scaled / scale;
    const fracPart = (scaled % scale).toString().padStart(places, "0");
    return places === 0 ? intPart.toString() : `${intPart}.${fracPart}`;
  }
}

function gcd(a: bigint, b: bigint): bigint {
  while (b !== 0n) { const t = a % b; a = b; b = t; }
  return a === 0n ? 1n : a;
}
