import { defineInterface, type JsonValue } from '@hediet/linkrpc'
import { GraphObjects, GraphRoot, graphRefSchema } from './interfaces'
import { validateGraphInterfaceSchema } from './reflection'
import { z } from 'zod'

const objects = GraphObjects({ ref: graphRefSchema, value: z.json() as z.ZodType<JsonValue> })

export const graphInterface = defineInterface({ id: 'linkrpc.graph.v1' }, {
  objects,
  workspace: GraphRoot({ params: z.object({}), ref: graphRefSchema }),
})

// A typed GraphRoot watch is a lease, not an object fetch. Visible consumers pin
// their references independently of the workspace ACK advancing to a new root.
export const retainedGraphInterface = defineInterface({ id: 'linkrpc.graph.retained.v1' }, {
  objects,
  root: GraphRoot({ params: z.object({ ref: graphRefSchema }), ref: graphRefSchema }),
})

validateGraphInterfaceSchema(graphInterface.toSchema())
validateGraphInterfaceSchema(retainedGraphInterface.toSchema())
