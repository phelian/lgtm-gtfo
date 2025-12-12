export type PrInfo = {
  repo: string | null;
  prNumber: number | null;
};

const patterns = [
  /\[(.+?)\] (?:Re: )?(?:.+?) \(#(\d+)\)/,
  /\[(.+?)\] .+#(\d+)/,
  /Re: \[(.+?)\] .+#(\d+)/,
];

export const parsePrFromSubject = (subject: string): PrInfo => {
  for (const pattern of patterns) {
    const match = subject.match(pattern);
    if (match) {
      return { repo: match[1], prNumber: parseInt(match[2], 10) };
    }
  }
  return { repo: null, prNumber: null };
};
