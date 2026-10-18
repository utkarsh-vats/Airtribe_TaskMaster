// Request augmentations live here. pino-http already adds `req.id` and `req.log`.
// Later steps extend Express.Request, for example:
//
// declare global {
//   namespace Express {
//     interface Request {
//       user?: { id: string };                                          // set by authenticate
//       membership?: { role: ProjectRole };                             // set by loadMembership
//       validated?: { body?: unknown; params?: unknown; query?: unknown }; // set by validate()
//     }
//   }
// }

export {};
