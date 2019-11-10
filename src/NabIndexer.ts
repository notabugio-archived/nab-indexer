import createAdapter from '@chaingun/node-adapters'
import {
  ChainGunSeaClient,
  GunGraph,
  GunGraphAdapter,
  GunGraphConnector,
  GunGraphConnectorFromAdapter,
  GunProcessQueue
} from '@chaingun/sea-client'
import { pubFromSoul, unpackNode } from '@chaingun/sear'
import SocketClusterGraphConnector from '@chaingun/socketcluster-connector'
import { Config, Query } from '@notabug/peer'
import { idsToIndex, indexThing } from './functions'

const READ_TIMEOUT = 2000

interface Opts {
  readonly socketCluster: any
}

const DEFAULT_OPTS: Opts = {
  socketCluster: {
    autoReconnect: true,
    hostname: process.env.GUN_SC_HOST || 'localhost',
    port: process.env.GUN_SC_PORT || '4444'
  }
}

Config.update({
  indexer: process.env.GUN_SC_PUB,
  tabulator: process.env.NAB_TABULATOR || process.env.GUN_SC_PUB
})

export class NabIndexer extends ChainGunSeaClient {
  public readonly socket: SocketClusterGraphConnector
  public readonly dbAdapter: GunGraphAdapter
  public readonly dbConnector: GunGraphConnector
  public readonly indexerQueue: GunProcessQueue<any>

  constructor(options = DEFAULT_OPTS) {
    const { socketCluster: scOpts, ...opts } = {
      ...DEFAULT_OPTS,
      ...options
    }

    const graph = new GunGraph()
    const dbAdapter = createAdapter()
    const dbConnector = new GunGraphConnectorFromAdapter(dbAdapter)

    dbConnector.sendRequestsFromGraph(graph as any)
    const socket = new SocketClusterGraphConnector(options.socketCluster)
    graph.connect(dbConnector as any)
    graph.opt({ mutable: true })

    dbConnector.sendPutsFromGraph(graph as any)

    super({ graph, ...opts })
    socket.socket.on('connect', this.authenticate.bind(this))

    this.dbAdapter = dbAdapter
    this.dbConnector = dbConnector
    this.directRead = this.directRead.bind(this)

    this.indexerQueue = new GunProcessQueue()
    this.indexerQueue.middleware.use(id => indexThing(this, id))

    this.socket = socket

    this.socket.subscribeToChannel(
      'gun/put/diff',
      this.didReceiveDiff.bind(this)
    )
  }

  public authenticate(): void {
    if (process.env.GUN_ALIAS && process.env.GUN_PASSWORD && !this.user().is) {
      this.user()
        .auth(process.env.GUN_ALIAS, process.env.GUN_PASSWORD)
        .then(() => {
          // tslint:disable-next-line: no-console
          console.log(`Logged in as ${process.env.GUN_ALIAS}`)
        })
    }
  }

  public newScope(): any {
    return Query.createScope(
      { gun: this },
      {
        getter: this.directRead,
        unsub: true
      }
    )
  }

  public directRead(soul: string): Promise<any> {
    return new Promise((ok, fail) => {
      const timeout = setTimeout(
        () => fail(new Error('Read timeout')),
        READ_TIMEOUT
      )

      function done(val: any): void {
        clearTimeout(timeout)
        ok(val)
      }

      this.dbAdapter.get(soul).then(node => {
        if (pubFromSoul(soul)) {
          unpackNode(node, 'mutable')
        }

        done(node)
      })
    })
  }

  protected didReceiveDiff(msg: any): void {
    const ids = idsToIndex(msg)
    if (ids.length) {
      // tslint:disable-next-line: readonly-array
      this.indexerQueue.enqueueMany(ids as string[])
    }
    this.indexerQueue.process()
  }
}
