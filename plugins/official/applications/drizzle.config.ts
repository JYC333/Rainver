// Plugin migrations are generated from schema.ts, from server/ (whose node_modules resolve drizzle):
//   NODE_PATH=node_modules node node_modules/drizzle-kit/bin.cjs generate --config ../plugins/official/applications/drizzle.config.ts --name <name>
// Generated SQL must not create the schema: the offline installer provisions `plugin_applications` and its roles.
export default {
  dialect: 'postgresql',
  schema: '../plugins/official/applications/schema.ts',
  out: '../plugins/official/applications/migrations',
};
