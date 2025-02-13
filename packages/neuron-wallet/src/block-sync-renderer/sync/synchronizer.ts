import { Subject } from 'rxjs'
import { queue, QueueObject } from 'async'
import { Indexer as CkbIndexer, CellCollector } from '@ckb-lumos/ckb-indexer'
import { QueryOptions } from '@ckb-lumos/base'
import AddressMeta from '../../database/address/meta'
import { Address } from '../../models/address'
import { SyncAddressType } from '../../database/chain/entities/sync-progress'
import IndexerCacheService from './indexer-cache-service'
import logger from '../../utils/logger'
import IndexerTxHashCache from '../../database/chain/entities/indexer-tx-hash-cache'

export interface BlockTips {
  cacheTipNumber: number
  indexerTipNumber: number | undefined
}

export interface LumosCellQuery {
  lock: CKBComponents.Script | null
  type: CKBComponents.Script | null
  data: string | null
}

export interface LumosCell {
  blockHash: string
  outPoint: {
    txHash: string
    index: string
  }
  cellOutput: {
    capacity: string
    lock: {
      codeHash: string
      args: string
      hashType: string
    }
    type?: {
      codeHash: string
      args: string
      hashType: string
    }
  }
  data?: string
}

export interface AppendScript {
  walletId: string
  script: CKBComponents.Script
  addressType: SyncAddressType
  scriptType: CKBRPC.ScriptType
}

export abstract class Synchronizer {
  public readonly blockTipsSubject: Subject<BlockTips> = new Subject<BlockTips>()
  public readonly transactionsSubject = new Subject<{ txHashes: CKBComponents.Hash[]; params: string }>()
  protected indexer: CkbIndexer
  protected processNextBlockNumberQueue: QueueObject<void>
  protected processingBlockNumber?: string
  protected addressesByWalletId: Map<string, AddressMeta[]> = new Map()
  protected pollingIndexer: boolean = false
  private indexerQueryQueue: QueueObject<LumosCellQuery> | undefined

  abstract connect(): Promise<void>
  abstract processTxsInNextBlockNumber(): Promise<void>
  protected abstract upsertTxHashes(): Promise<unknown>
  public abstract notifyCurrentBlockNumberProcessed(blockNumber: string): Promise<void>
  async appendScript(_scripts: AppendScript[]) {
    // do nothing
  }

  constructor({ addresses, nodeUrl, indexerUrl }: { addresses: Address[]; nodeUrl: string; indexerUrl: string }) {
    this.indexer = new CkbIndexer(nodeUrl, indexerUrl)
    this.addressesByWalletId = addresses
      .map(address => AddressMeta.fromObject(address))
      .reduce((addressesByWalletId, addressMeta) => {
        if (!addressesByWalletId.has(addressMeta.walletId)) {
          addressesByWalletId.set(addressMeta.walletId, [])
        }

        const addressMetas = addressesByWalletId.get(addressMeta.walletId)
        addressMetas!.push(addressMeta)

        return addressesByWalletId
      }, new Map<string, AddressMeta[]>())

    this.processNextBlockNumberQueue = queue(async () => this.processTxsInNextBlockNumber(), 1)
    this.processNextBlockNumberQueue.error((err: any) => {
      logger.error(`Connector: \tError in processing next block number queue: ${err}`)
    })

    this.indexerQueryQueue = queue(async (query: any) => {
      return await this.collectLiveCellsByScript(query)
    })
  }

  public stop(): void {
    this.pollingIndexer = false
  }

  protected async processNextBlockNumber() {
    // the processNextBlockNumberQueue is a queue to ensure that ONLY one
    // block processing task runs at a time to avoid the data conflict while syncing
    this.processNextBlockNumberQueue?.push()
    await this.processNextBlockNumberQueue?.drain()
  }

  protected async getTxHashesWithNextUnprocessedBlockNumber(): Promise<[string | undefined, string[]]> {
    const txHashCachesByNextBlockNumberAndAddress = await Promise.all(
      [...this.addressesByWalletId.keys()].map(async walletId =>
        IndexerCacheService.nextUnprocessedTxsGroupedByBlockNumber(walletId)
      )
    )
    const groupedTxHashCaches = txHashCachesByNextBlockNumberAndAddress.flat().reduce((grouped, txHashCache) => {
      if (!grouped.get(txHashCache.blockNumber.toString())) {
        grouped.set(txHashCache.blockNumber.toString(), [])
      }
      grouped.get(txHashCache.blockNumber.toString())!.push(txHashCache)

      return grouped
    }, new Map<string, Array<IndexerTxHashCache>>())

    const nextUnprocessedBlockNumber = [...groupedTxHashCaches.keys()].sort((a, b) => parseInt(a) - parseInt(b)).shift()

    if (!nextUnprocessedBlockNumber) {
      return [undefined, []]
    }

    const txHashCachesInNextUnprocessedBlockNumber = groupedTxHashCaches.get(nextUnprocessedBlockNumber)

    return [nextUnprocessedBlockNumber, txHashCachesInNextUnprocessedBlockNumber!.map(({ txHash }) => txHash)]
  }

  protected async notifyAndSyncNext(indexerTipNumber: number) {
    const nextUnprocessedBlockNumber = await IndexerCacheService.nextUnprocessedBlock([
      ...this.addressesByWalletId.keys(),
    ])
    if (nextUnprocessedBlockNumber) {
      this.blockTipsSubject.next({
        cacheTipNumber: parseInt(nextUnprocessedBlockNumber),
        indexerTipNumber,
      })
      if (!this.processingBlockNumber) {
        await this.processNextBlockNumber()
      }
      return true
    }
    this.blockTipsSubject.next({
      cacheTipNumber: indexerTipNumber,
      indexerTipNumber,
    })
    return false
  }

  public async getLiveCellsByScript(query: LumosCellQuery) {
    return new Promise((resolve, reject) => {
      this.indexerQueryQueue!.push(query, (err: any, result: unknown) => {
        if (err) {
          return reject(err)
        }
        resolve(result)
      })
    })
  }

  private async collectLiveCellsByScript(query: LumosCellQuery) {
    const { lock, type, data } = query
    if (!lock && !type) {
      throw new Error('at least one parameter is required')
    }

    const queries: QueryOptions = {
      ...(lock ? { lock } : {}),
      ...(type ? { type } : {}),
      data: data || 'any',
    }

    const collector = new CellCollector(this.indexer, queries)

    const result = []
    for await (const cell of collector.collect()) {
      //somehow the lumos indexer returns an invalid hash type "lock" for hash type "data"
      //for now we have to fix it here
      const cellOutput = cell.cellOutput
      // FIXME
      // eslint-disable-next-line @typescript-eslint/ban-ts-comment
      // @ts-expect-error
      if (cellOutput.type?.hashType === 'lock') {
        console.error('Unexpected hash type "lock" found with the query', JSON.stringify(queries))
        cellOutput.type.hashType = 'data'
      }
      result.push(cell)
    }
    return result
  }
}
