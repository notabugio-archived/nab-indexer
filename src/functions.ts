import { Config, Listing, Query, Schema, ThingDataNode } from '@notabug/client'
import { NabIndexer } from './NabIndexer'

const WRITE_TIMEOUT = 2000

const { ListingSort, ListingNode, ListingSpec } = Listing

export async function getListings(
  scope: any,
  thingId: string
): Promise<readonly string[]> {
  if (!thingId) {
    return []
  }
  // tslint:disable-next-line: readonly-array
  const listings: string[] = []

  const [data, scores] = await Promise.all([
    Query.thingData(scope, thingId),
    Query.thingScores(scope, thingId)
  ])

  if (!data) {
    return []
  }

  const kind = ThingDataNode.kind(data)
  const authorId = ThingDataNode.authorId(data)
  const topic = ThingDataNode.topic(data)
    .trim()
    .toLowerCase()

  if (kind === 'submission') {
    const domain = ThingDataNode.domain(data)
    const commands = (scores && scores.commands) || {}
    // tslint:disable-next-line: readonly-array
    const taggedBy: any[] = []

    for (const key in commands) {
      if (key !== 'anon') {
        taggedBy.push(key)
      }
    }

    if (topic) {
      listings.push(`/t/${topic}`)
    }

    if (topic !== 'all') {
      const dotIdx = topic.indexOf('.')

      if (dotIdx === -1 || dotIdx === 0) {
        listings.push('/t/all')
      } else {
        const source = topic.slice(0, dotIdx)

        if (source !== 'test') {
          listings.push('/t/external.all')
        }

        listings.push(`/t/${source}.all`)
      }
    }

    if (domain) {
      listings.push(`/domain/${domain}`)
    }

    if (authorId) {
      listings.push(`/user/${authorId}/submitted`)
      listings.push(`/user/${authorId}/overview`)
    }

    taggedBy.forEach(tagAuthorId =>
      listings.push(`/user/${tagAuthorId}/commented`)
    )
  } else if (kind === 'comment') {
    const opId = ThingDataNode.opId(data)
    const replyToId = ThingDataNode.replyToId(data)
    const isCommand = ThingDataNode.isCommand(data)

    if (opId) {
      listings.push(`/things/${opId}/comments`)
    }
    if (topic) {
      listings.push(`/t/comments:${topic}`)
    }

    if (topic !== 'all') {
      const dotIdx = topic.indexOf('.')

      if (dotIdx === -1 || dotIdx === 0) {
        listings.push('/t/comments:all')
      } else {
        const source = topic.slice(0, dotIdx)

        if (source !== 'test') {
          listings.push('/t/comments:external.all')
        }

        listings.push(`/t/comments:${source}.all`)
      }
    }

    if (replyToId) {
      const replyToThingData = await Query.thingData(scope, replyToId)
      const replyToAuthorId = ThingDataNode.authorId(replyToThingData)

      if (replyToAuthorId) {
        const replyToKind = ThingDataNode.kind(replyToThingData)
        listings.push(`/user/${replyToAuthorId}/replies/overview`)
        if (replyToKind === 'submission') {
          listings.push(`/user/${replyToAuthorId}/replies/submitted`)
        } else if (replyToKind === 'comment') {
          listings.push(`/user/${replyToAuthorId}/replies/comments`)
        }
      }
    }

    if (authorId) {
      listings.push(`/user/${authorId}/comments`)
      listings.push(`/user/${authorId}/overview`)
      if (isCommand) {
        listings.push(`/user/${authorId}/commands`)
      }
      // TODO: update commented
    }
  } else if (kind === 'chatmsg') {
    if (topic) {
      listings.push(`/t/chat:${topic}`)
    }
    if (topic !== 'all') {
      const dotIdx = topic.indexOf('.')

      if (dotIdx === -1 || dotIdx === 0) {
        listings.push('/t/chat:all')
      } else {
        const source = topic.slice(0, dotIdx)

        if (source !== 'test') {
          listings.push('/t/chat:external.all')
        }
        listings.push(`/t/chat:${source}.all`)
      }
    }
  }

  return listings
}

export async function describeThingId(
  scope: any,
  thingId: string
): Promise<{
  readonly id: string
  readonly includes: readonly string[]
  readonly sorts: ReadonlyArray<readonly any[]>
}> {
  if (!thingId) {
    return null
  }
  const spec = ListingSpec.fromSource('')
  const includes: readonly string[] = await getListings(scope, thingId)
  if (!includes.length) {
    return null
  }

  return {
    id: thingId,
    includes,
    sorts: await Promise.all(
      Object.keys(ListingSort.sorts).map(async name => [
        name,
        await ListingSort.sorts[name](scope, thingId, spec)
      ])
    )
  }
}

export const descriptionToListingMap = (declarativeUpdate: any) => {
  const id = (declarativeUpdate && declarativeUpdate.id) || ''
  const includes = (declarativeUpdate && declarativeUpdate.includes) || []
  const sorts: ReadonlyArray<readonly [string, number]> =
    (declarativeUpdate && declarativeUpdate.sorts) || []
  // tslint:disable-next-line: readonly-array
  const results: any[] = []

  for (const listing of includes) {
    for (const [sortName, value] of sorts) {
      results.push([`${listing}/${sortName}`, [[id, value]]])
    }
  }

  return results
}

let globalScope

export async function indexThing(peer: NabIndexer, id: string): Promise<void> {
  const startedAt = new Date().getTime()
  const scope = (globalScope = globalScope || peer.newScope())

  try {
    const description = await describeThingId(scope, id)
    const listingMap: readonly any[] = descriptionToListingMap(description)

    const putData: any = {}

    const souls = listingMap.map(item => {
      const [listingPath]: readonly [
        string,
        ReadonlyArray<readonly [string, number]>
      ] = item
      return ListingNode.soulFromPath(Config.tabulator, listingPath)
    })

    if (!souls.length) {
      // tslint:disable-next-line: no-console
      console.log('no souls', id, listingMap)
    }

    const nodes = {}

    await Promise.all(
      souls.map(soul =>
        scope.get(soul).then(node => {
          nodes[soul] = node
        })
      )
    )

    await Promise.all(
      listingMap.map(async item => {
        const [listingPath, updatedItems]: readonly [
          string,
          ReadonlyArray<readonly [string, number]>
        ] = item
        const soul = ListingNode.soulFromPath(Config.tabulator, listingPath)
        const existing = nodes[soul]
        const diff = await ListingNode.diff(existing, updatedItems as any, [])

        if (!diff) {
          return
        }
        putData[listingPath] = {
          _: {
            '#': soul
          },
          ...diff
        }
      })
    )

    if (Object.keys(putData).length) {
      const listingsSoul = Schema.ThingListingsMeta.route.reverse({
        tabulator: Config.tabulator,
        thingId: id
      })
      if (listingsSoul) {
        await new Promise((ok, fail) => {
          const timeout = setTimeout(
            () => fail(new Error('Write timeout')),
            WRITE_TIMEOUT
          )

          function done(): void {
            clearTimeout(timeout)
            ok()
          }

          peer.get(listingsSoul).put(putData, done)
        })
      }
    }
  } catch (e) {
    // tslint:disable-next-line: no-console
    console.error('Indexer error', e.stack || e)
  } finally {
    // scope.off()
  }

  const endedAt = new Date().getTime()
  // tslint:disable-next-line: no-console
  console.log('indexed', (endedAt - startedAt) / 1000, id)
}

export function idsToIndex(msg: any): readonly string[] {
  // tslint:disable-next-line: readonly-array
  const ids: any[] = []
  const put = msg && msg.put
  if (!put) {
    return ids
  }

  for (const soul in put) {
    if (!soul) {
      continue
    }
    const thingMatch = Schema.Thing.route.match(soul)
    const countsMatch = Schema.ThingVoteCounts.route.match(soul)
    if (countsMatch && countsMatch.tabulator !== Config.tabulator) {
      continue
    }
    const thingId = (thingMatch || countsMatch || {}).thingId || ''

    if (thingId && ids.indexOf(thingId) === -1) {
      ids.push(thingId)
    }
  }

  return ids
}
