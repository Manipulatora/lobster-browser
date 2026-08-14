export interface ThreadMessage {
  role: string;
  content: string;
  status?: string;
  ts?: string;
  turnId?: string;
}

export interface ThreadExchange {
  task: string;
  response: string;
  status: 'done' | 'error' | 'stopped';
  startedAt?: string;
  turnId?: string;
}

/** Convert the encrypted user/assistant wire format into complete exchanges, ignoring compactions. */
export function threadExchanges(messages: readonly ThreadMessage[]): ThreadExchange[] {
  const exchanges: ThreadExchange[] = [];
  for (let index = 0; index < messages.length; index += 1) {
    const user = messages[index];
    const assistant = messages[index + 1];
    if (user?.role !== 'user' || assistant?.role !== 'assistant') continue;
    const status =
      assistant.status === 'error' || assistant.status === 'stopped' ? assistant.status : 'done';
    exchanges.push({
      task: user.content,
      response: assistant.content,
      status,
      ...(user.ts ? { startedAt: user.ts } : {}),
      ...(assistant.turnId ? { turnId: assistant.turnId } : {}),
    });
    index += 1;
  }
  return exchanges;
}

export interface LocalHistoryIdentity {
  turnId?: string;
  task?: string;
  response?: string;
  status: 'done' | 'error' | 'stopped';
}

export interface HistoryMatchResult {
  matches: Array<{ exchangeIndex: number; metadataIndex: number }>;
  unmatchedExchangeIndices: number[];
  unmatchedMetadataIndices: number[];
}

/** Select only the retained run owned by the conversation currently open in the panel. */
export function findSnapshotForThread<T extends { threadId?: string }>(
  snapshots: readonly T[] | null | undefined,
  threadId: string,
): T | undefined {
  return snapshots?.find((snapshot) => snapshot.threadId === threadId);
}

/**
 * Match local metadata to encrypted exchanges without positional guessing. Stable server-issued ids
 * win. A legacy plaintext row may be retired only when its complete task/outcome/status identifies
 * exactly one encrypted exchange. Ambiguous or body-less metadata remains unmatched and retained.
 */
export function matchThreadHistory(
  exchanges: readonly ThreadExchange[],
  metadata: readonly LocalHistoryIdentity[],
): HistoryMatchResult {
  const usedExchanges = new Set<number>();
  const usedMetadata = new Set<number>();
  const matches: Array<{ exchangeIndex: number; metadataIndex: number }> = [];

  const claimUnique = (metadataIndex: number, candidates: number[]): void => {
    const available = candidates.filter((index) => !usedExchanges.has(index));
    if (available.length !== 1) return;
    const exchangeIndex = available[0]!;
    usedExchanges.add(exchangeIndex);
    usedMetadata.add(metadataIndex);
    matches.push({ exchangeIndex, metadataIndex });
  };

  metadata.forEach((item, metadataIndex) => {
    if (!item.turnId) return;
    claimUnique(
      metadataIndex,
      exchanges.flatMap((exchange, index) => (exchange.turnId === item.turnId ? [index] : [])),
    );
  });

  metadata.forEach((item, metadataIndex) => {
    if (usedMetadata.has(metadataIndex) || item.task === undefined || item.response === undefined)
      return;
    claimUnique(
      metadataIndex,
      exchanges.flatMap((exchange, index) =>
        exchange.task === item.task &&
        exchange.response === item.response &&
        exchange.status === item.status
          ? [index]
          : [],
      ),
    );
  });

  matches.sort((left, right) => left.exchangeIndex - right.exchangeIndex);
  return {
    matches,
    unmatchedExchangeIndices: exchanges.flatMap((_, index) =>
      usedExchanges.has(index) ? [] : [index],
    ),
    unmatchedMetadataIndices: metadata.flatMap((_, index) =>
      usedMetadata.has(index) ? [] : [index],
    ),
  };
}
