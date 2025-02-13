import initDB from '../../src/database/chain/ormconfig'
import { getConnection as originGetConnection } from 'typeorm'
import { TransactionPersistor } from '../../src/services/tx'
import AssetAccount from '../../src/models/asset-account'
import OutputEntity from '../../src/database/chain/entities/output'
import AssetAccountEntity from '../../src/database/chain/entities/asset-account'

export const initConnection = (genesisBlockHash?: string) => {
  return initDB(genesisBlockHash ?? ':memory:')
}

export const closeConnection = () => {
  return originGetConnection('full').close()
}

export const getConnection = () => {
  return originGetConnection('full')
}

export const saveTransactions = async (txs: any) => {
  for (const tx of txs) {
    // TODO: do not use private methods
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore: Private method
    await TransactionPersistor.saveWithFetch(tx)
  }
}

export const createAccounts = async (assetAccounts: AssetAccount[], outputEntities: OutputEntity[]) => {
  const entities = assetAccounts.map(aa => AssetAccountEntity.fromModel(aa))
  const accountIds: number[] = []
  for (const entity of entities) {
    await getConnection().manager.save([entity.sudtTokenInfo])
    const [assetAccount] = await getConnection().manager.save([entity])
    accountIds.push(assetAccount.id)
  }

  for (const o of outputEntities) {
    await getConnection().manager.save([o.transaction, o])
  }

  return accountIds
}

export const saveAccounts = async (accounts: AssetAccount[]) => {
  for (const account of accounts) {
    const entity = AssetAccountEntity.fromModel(account)
    await getConnection().manager.save([entity.sudtTokenInfo, entity])
  }
}
