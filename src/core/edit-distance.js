// Bounded Levenshtein distance. Used only to check whether two terms are
// within a small typo budget of each other, so the caller always has a
// max in hand -- there is never a reason to compute the exact distance
// once it is already known to be past that budget.

export function withinEditDistance(a, b, max) {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > max) return false;

  let previous = new Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) previous[j] = j;

  for (let i = 1; i <= a.length; i++) {
    const current = new Array(b.length + 1);
    current[0] = i;
    let rowMin = current[0];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(
        previous[j] + 1,
        current[j - 1] + 1,
        previous[j - 1] + cost
      );
      if (current[j] < rowMin) rowMin = current[j];
    }
    if (rowMin > max) return false;
    previous = current;
  }

  return previous[b.length] <= max;
}
