# Feature Update Requirements

Integrate the following capabilities into the existing CLI tool's migration workflow:

## 1. Semantic Intent Routing
- The CLI should function as a conversational assistant for general queries.
- Implement an intent router (via tool/function calling) so that if a user describes a migration task in natural language (e.g., "Here is my legacy codebase, migrate this to [target language]"), the LLM automatically triggers the migration workflow.
- The explicit `/migrate` command should remain functional, but the user should not be required to use it if their semantic intent is clear.

## 2. Broad Legacy Language Support
- Ensure the static analysis capabilities support reading and parsing legacy enterprise languages, specifically including Delphi, Pascal, VB6, and C++.
- The file ingestion pipeline must recognize these legacy file extensions (e.g., `.pas`, `.frm`, `.vbp`, `.cpp`) and pass their contents to the LLM for context.

## 3. Dependency Modernization Mapping
- During the migration analysis, evaluate legacy dependencies, libraries, and plugins.
- The LLM must assess whether a dependency is needed in the new target stack and categorize it:
    - **Deprecate:** Target stack handles this natively; dependency no longer needed.
    - **Migrate:** Recommend the modern industry-standard equivalent.
    - **Retain:** Dependency is still required and valid.

## 4. Database Discovery & Secure Interrogation
- **Static Analysis Phase:** Analyze legacy code to deduce the database dialect (e.g., Oracle, MS SQL) and extract queries, ORM configurations, and database interactions to understand how the legacy app connects and receives data.
- **Secure Interrogation Phase:** - The tool must **never** automatically execute or use connection strings found in the legacy code.
    - Pause the automated flow to request explicit user approval to connect to the database.
    - If connection details are missing or unclear, prompt the user to manually provide a connection string or credentials via a highly secure, masked input prompt. Specify that only Read-Only credentials should be used.
- **Schema Extraction:** Once securely connected, extract strictly structural metadata (table names, column definitions) to map against the queries found during static analysis. Do not extract or query actual table data.

## 5. Knowledge Base (KB) Generation
- Synthesize the dependency mapping, database schema, query mapping, and legacy architecture into structured Markdown files.
- These generated files will serve as the instruction set and Knowledge Base for generating the modern repository.