/**
 * Split streaming text into blocks at blank lines outside code fences and
 * math blocks. Finished blocks never change, so while a reply streams only
 * the last block is parsed again on each frame instead of the whole reply.
 */
export function splitBlocks(md: string): string[] {
  const lines = md.split('\n');
  const blocks: string[] = [];
  let cur: string[] = [];
  let fence = false;
  let math = false;
  const listItem = /^\s*([-*+]|\d+[.)]) /;
  for (const line of lines) {
    const t = line.trimStart();
    const prevBlank = cur.length > 0 && cur[cur.length - 1].trim() === '';
    if (!fence && !math && prevBlank && t !== '') {
      const last = [...cur].reverse().find((l) => l.trim() !== '') ?? '';
      // indented lines, further list items and further table rows continue the block
      const continues =
        /^\s/.test(line) ||
        (listItem.test(line) && (listItem.test(last) || /^\s/.test(last))) ||
        (t.startsWith('|') && last.trimStart().startsWith('|'));
      if (!continues) {
        blocks.push(cur.join('\n'));
        cur = [];
      }
    }
    if (t.startsWith('```')) fence = !fence;
    else if (!fence && t.startsWith('$$')) math = !math;
    cur.push(line);
  }
  if (cur.length) blocks.push(cur.join('\n'));
  return blocks;
}
