// 精确有理数：内部全部计算使用 BigInt 分数，不在中间层四舍五入。
export class Frac {
  readonly num: bigint;
  readonly den: bigint; // 恒为正

  private constructor(num: bigint, den: bigint) {
    this.num = num;
    this.den = den;
  }

  static of(num: bigint, den: bigint = 1n): Frac {
    if (den === 0n) throw new Error("分母为零");
    if (den < 0n) { num = -num; den = -den; }
    const g = gcd(abs(num), den);
    return new Frac(num / g, den / g);
  }

  static zero(): Frac { return new Frac(0n, 1n); }

  /** 解析最多 6 位小数的非负十进制字符串为精确分数。 */
  static parseDecimal(s: string, what: string): Frac {
    if (typeof s !== "string" || !/^\d+(\.\d{1,6})?$/.test(s)) {
      throw new ApiError("INVALID_MASS", `${what} 必须是最多 6 位小数的非负十进制字符串，收到: ${JSON.stringify(s)}`);
    }
    const [intPart, fracPart = ""] = s.split(".");
    const scaled = BigInt(intPart + fracPart.padEnd(6, "0"));
    return Frac.of(scaled, 1_000_000n);
  }

  add(o: Frac): Frac { return Frac.of(this.num * o.den + o.num * this.den, this.den * o.den); }
  sub(o: Frac): Frac { return Frac.of(this.num * o.den - o.num * this.den, this.den * o.den); }
  mul(o: Frac): Frac { return Frac.of(this.num * o.num, this.den * o.den); }
  div(o: Frac): Frac {
    if (o.num === 0n) throw new Error("除以零");
    return Frac.of(this.num * o.den, this.den * o.num);
  }
  isZero(): boolean { return this.num === 0n; }
  isPositive(): boolean { return this.num > 0n; }
  equals(o: Frac): boolean { return this.num === o.num && this.den === o.den; }

  /** 精确分数字符串，如 "2/3"、"450" */
  toString(): string {
    return this.den === 1n ? this.num.toString() : `${this.num}/${this.den}`;
  }

  /** 固定小数展示（仅用于显示，不参与后续计算）。 */
  toFixed(places: number): string {
    const scale = 10n ** BigInt(places);
    const scaled = (this.num * scale * 2n + this.den) / (2n * this.den); // 四舍五入
    const intPart = scaled / scale;
    const fracPart = (scaled % scale).toString().padStart(places, "0");
    return `${intPart}.${fracPart}`;
  }
}

function abs(x: bigint): bigint { return x < 0n ? -x : x; }
function gcd(a: bigint, b: bigint): bigint {
  while (b !== 0n) { const t = a % b; a = b; b = t; }
  return a === 0n ? 1n : a;
}

export type ErrorCode =
  | "INVALID_MASS"
  | "INVALID_INPUT"
  | "NOT_FOUND"
  | "UNKNOWN_MIXTURE_VERSION"
  | "CIRCULAR_REFERENCE"
  | "EXPANSION_TOO_DEEP"
  | "TOO_MANY_ITEMS"
  | "NO_FLOUR"
  | "EMPTY_MIXTURE"
  | "ZERO_TOTAL_MASS"
  | "DUPLICATE_NAME";

export class ApiError extends Error {
  readonly code: ErrorCode;
  readonly details?: unknown;
  constructor(code: ErrorCode, message: string, details?: unknown) {
    super(message);
    this.code = code;
    this.details = details;
  }
}
