export interface MotionRange {
  start: number;
  end: number;
}
/** Bounded union of ready chapter intervals, all bound to one source/render identity. */
export class MotionReviewCoverage {
  private identity = "";
  private ranges = new Map<string, { range: MotionRange; ready: boolean }>();
  clear(): void {
    this.identity = "";
    this.ranges.clear();
  }
  record(identity: string, range: MotionRange, ready: boolean): void {
    if (identity !== this.identity) {
      this.clear();
      this.identity = identity;
    }
    const key = `${range.start}:${range.end}`;
    if (!this.ranges.has(key) && this.ranges.size >= 20)
      throw new Error("Chapter coverage limit reached (20)");
    this.ranges.set(key, { range, ready });
  }
  complete(identity: string, duration: number): boolean {
    if (identity !== this.identity) return false;
    let end = 0;
    for (const entry of [...this.ranges.values()].sort((a, b) => a.range.start - b.range.start)) {
      if (!entry.ready) continue;
      if (entry.range.start > end + 0.000001) return false;
      end = Math.max(end, entry.range.end);
    }
    return end >= duration;
  }
}
