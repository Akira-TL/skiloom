export function compareUtf8(left: string, right: string): number {
  const leftBytes = Buffer.from(left, "utf8");
  const rightBytes = Buffer.from(right, "utf8");
  const commonLength = Math.min(leftBytes.length, rightBytes.length);

  for (let index = 0; index < commonLength; index += 1) {
    const difference = (leftBytes[index] ?? 0) - (rightBytes[index] ?? 0);
    if (difference !== 0) {
      return difference;
    }
  }

  return leftBytes.length - rightBytes.length;
}
