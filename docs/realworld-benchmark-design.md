# RealWorld API Benchmark Design Context

Use this document as a neutral architecture and business baseline when testing CCS against
`https://github.com/gothinkster/node-express-realworld-example-app`.

This is not a company-specific modernization profile. It is a small benchmark context file
so the migration run can test the full CCS flow: repo scan, business context ingestion,
target architecture decisions, verification, dashboard generation, and agent handoff.

## Business Goal

Modernize the RealWorld "Conduit" API from a Node.js Express and Prisma implementation into a
C# ASP.NET Core Web API while preserving the public API behavior expected by RealWorld clients.

The migrated system should remain a learning-grade but production-shaped content API. It should
keep the same user workflows, REST contracts, authentication behavior, persistence semantics,
validation errors, and authorization rules so existing RealWorld frontends can continue to use it.

## In Scope

- User registration, login, current-user lookup, and profile update.
- JWT-based authentication and current-user identity propagation.
- Profile lookup plus follow and unfollow behavior.
- Article listing, filtering, feed, create, read, update, delete, favorite, and unfavorite.
- Article comments: list, add, and delete.
- Tag listing.
- PostgreSQL persistence using the existing domain model: User, Article, Comment, Tag, favorites,
  follows, and article-tag relationships.
- API response shapes and status/error semantics compatible with the RealWorld API contract.

## Out of Scope

- Frontend migration.
- Payment, notification, analytics, moderation, or admin workflows.
- Splitting this benchmark into independent deployable microservices.
- Replacing PostgreSQL with a document database or event store.
- Changing the public API contract unless the source code clearly already differs from the
  RealWorld API convention.

## Target Architecture Direction

Prefer a modular monolith ASP.NET Core Web API, not serverless functions or separate microservices.

Recommended target structure:

- `Api` layer: ASP.NET Core controllers or minimal API route groups that preserve REST paths,
  status codes, and JSON response envelopes.
- `Application` layer: use-case services for auth, profiles, articles, comments, and tags.
- `Domain` layer: entities and business rules for users, articles, comments, tags, following,
  favorites, and ownership checks.
- `Infrastructure` layer: EF Core DbContext, PostgreSQL mappings, migrations, password hashing,
  JWT token creation, and repository/query helpers where useful.

The architecture agent should classify most runtime components as `rest_api`, domain/application
services, or persistence adapters. Use `common_library` only for reusable mapping, token, error,
or validation helpers. Use `integration_adapter` for the database/ORM boundary. Do not suggest
Azure Functions, Logic Apps, Service Bus, Databricks, or AKS unless source evidence strongly proves
an asynchronous, batch, or orchestration workload.

## Business Rules To Preserve

- Email, username, and article slug uniqueness are business constraints.
- Registration requires email, username, and password. Blank required fields return validation
  errors.
- Passwords are stored only as hashes. Plaintext passwords must never be returned by the API.
- Login validates email and password and returns a JWT-bearing user response on success.
- Authenticated requests identify the current user from the JWT.
- Users may update only their own user profile.
- Article creation requires title, description, and body.
- Article slugs are generated from the title and user id. Slug uniqueness must be preserved.
- Only the article author may update or delete an article.
- Only a comment author may delete that comment.
- Favorite and unfavorite operations update the relationship between the current user and the
  article and return an article representation with favorite state and count.
- Follow and unfollow operations update the relationship between the current user and the target
  profile and return a profile representation with following state.
- Feed returns articles written by followed authors, ordered newest first.
- Article listing supports filtering by tag, author, and favorited user, plus limit and offset.
- Tag listing returns popular tags from visible articles.
- The source includes a `demo` visibility flag. Preserve the current source behavior around demo
  users/articles unless a test explicitly proves it should be changed.

## Data Contract Baseline

Primary entities:

- User: id, email, username, password hash, image, bio, demo flag.
- Article: id, slug, title, description, body, createdAt, updatedAt, author, tags, favorites,
  comments.
- Comment: id, body, createdAt, updatedAt, article, author.
- Tag: id, name, related articles.

Important API response concepts:

- User responses include email, username, bio, image, and token when appropriate.
- Profile responses include username, bio, image, and following.
- Article responses include slug, title, description, body, tagList, timestamps, favorited,
  favoritesCount, and author profile.
- Comment responses include id, timestamps, body, and author profile.
- List responses include the collection and total count where the RealWorld API expects it.

## Validation Scenarios

Use these scenarios to judge whether the generated migration reports and later rewritten code are
useful:

- Register a new user, then log in with the same credentials and receive a token.
- Attempt registration with a duplicate email or username and receive a validation error.
- Create an article with tags, then read it by slug and confirm article fields, tagList, author,
  favoritesCount, and favorited are correct.
- Try to update or delete an article as a different user and receive an authorization error.
- Follow another user, then request the feed and confirm followed-author articles appear in newest
  first order.
- Favorite and unfavorite an article and confirm the returned favorite state and count change.
- Add and delete a comment as the comment author.
- List articles by tag, author, and favorited user with limit and offset.
- List tags and confirm only visible/popular tags are returned according to the source behavior.

## Expected CCS Report Quality

A good CCS report for this benchmark should:

- Identify auth, profiles, articles, comments, tags, routing, Prisma persistence, token helpers,
  mappers, and error handling as meaningful components.
- Produce a system graph that connects routes/controllers to services, services to Prisma, and
  article/profile/auth flows to shared mapping and JWT helpers.
- Treat the target as an ASP.NET Core Web API modular monolith.
- Mark uncertain claims as `needs_review`, but avoid blocking components only because the system is
  a public benchmark without enterprise architecture notes.
- Keep generated questions focused on real product decisions, such as whether demo visibility should
  remain, not on generic "what does this app do" questions.

