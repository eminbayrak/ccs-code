// ---------------------------------------------------------------------------
// Static knowledge table: source framework concepts → target framework patterns.
// Used to enrich LLM prompts so Sonnet knows what the right replacement is
// without having to infer it from scratch for every component.
// ---------------------------------------------------------------------------

export type FrameworkMapping = {
  sourceFramework: string;
  targetFramework: string;
  conceptMap: Array<{
    sourceConcept: string;
    targetConcept: string;
    targetPackage: string;
    notes: string;
  }>;
  setupNotes: string[];
  projectStructure: string;
};

const MAPPINGS: FrameworkMapping[] = [
  // ---------------------------------------------------------------------------
  // ASP.NET Core → FastAPI (Python)
  // ---------------------------------------------------------------------------
  {
    sourceFramework: "aspnet-core",
    targetFramework: "fastapi",
    conceptMap: [
      { sourceConcept: "ControllerBase / [ApiController]", targetConcept: "APIRouter",            targetPackage: "fastapi",          notes: "Each controller becomes an APIRouter; mount with app.include_router()" },
      { sourceConcept: "IActionResult / ActionResult<T>",  targetConcept: "return Pydantic model", targetPackage: "pydantic",         notes: "FastAPI serialises Pydantic models automatically; no wrapper needed" },
      { sourceConcept: "Service class (DI registered)",    targetConcept: "Service class + Depends()", targetPackage: "fastapi",     notes: "Use FastAPI Depends() for dependency injection; one instance per request by default" },
      { sourceConcept: "IRepository / Repository<T>",      targetConcept: "Repository class (SQLAlchemy Session)", targetPackage: "sqlalchemy", notes: "Inject Session via Depends(get_db)" },
      { sourceConcept: "DbContext (EF Core)",               targetConcept: "Session (SQLAlchemy)",  targetPackage: "sqlalchemy",      notes: "create_engine() + sessionmaker(); use context manager for transactions" },
      { sourceConcept: "Entity / [Table] class",            targetConcept: "SQLAlchemy ORM model",  targetPackage: "sqlalchemy",      notes: "Inherit from declarative_base(); map columns with mapped_column()" },
      { sourceConcept: "DTO / record",                      targetConcept: "Pydantic BaseModel",    targetPackage: "pydantic",        notes: "Use model_validator for cross-field rules; Field() for constraints" },
      { sourceConcept: "IConfiguration / appsettings.json", targetConcept: "BaseSettings",         targetPackage: "pydantic-settings", notes: "Reads from env vars and .env file automatically" },
      { sourceConcept: "IMiddleware / UseMiddleware",        targetConcept: "@app.middleware('http')", targetPackage: "fastapi",       notes: "Or use Starlette BaseHTTPMiddleware class" },
      { sourceConcept: "AutoMapper",                        targetConcept: "explicit .model_validate() or from_orm()", targetPackage: "pydantic", notes: "No AutoMapper equivalent; map explicitly in service layer" },
      { sourceConcept: "FluentValidation",                  targetConcept: "Pydantic validators / @field_validator", targetPackage: "pydantic", notes: "Move validation into Pydantic schema; raise ValueError in validators" },
      { sourceConcept: "ILogger<T>",                        targetConcept: "logging.getLogger(__name__)", targetPackage: "stdlib",    notes: "Configure with logging.basicConfig() or structlog for structured logs" },
      { sourceConcept: "xUnit / Moq",                       targetConcept: "pytest / unittest.mock", targetPackage: "pytest",        notes: "Use pytest fixtures for setup; patch() for mocking" },
      { sourceConcept: "Program.cs / Startup.cs",           targetConcept: "main.py + lifespan()",  targetPackage: "fastapi",        notes: "Wire routers, middleware, and startup logic in main.py" },
      { sourceConcept: "appsettings.json",                  targetConcept: ".env + BaseSettings",   targetPackage: "pydantic-settings", notes: "Keep secrets in .env; never commit" },
    ],
    setupNotes: [
      "pip install fastapi uvicorn sqlalchemy pydantic pydantic-settings alembic pytest",
      "Use Alembic for database migrations (equivalent to EF Core migrations)",
      "Run with: uvicorn main:app --reload",
      "Use async def endpoints if source code used async patterns",
    ],
    projectStructure: `
project/
├── main.py               # app factory, router mounts, lifespan
├── config.py             # BaseSettings
├── routers/              # one file per controller
├── services/             # one file per service
├── repositories/         # one file per repository
├── models/               # SQLAlchemy ORM models
├── schemas/              # Pydantic request/response models (DTOs)
├── middleware/           # custom middleware
├── tests/                # pytest test files
├── alembic/              # DB migration scripts
└── requirements.txt`,
  },

  // ---------------------------------------------------------------------------
  // ASP.NET Core → Django (Python)
  // ---------------------------------------------------------------------------
  {
    sourceFramework: "aspnet-core",
    targetFramework: "django",
    conceptMap: [
      { sourceConcept: "ControllerBase",       targetConcept: "APIView / ViewSet",        targetPackage: "djangorestframework", notes: "Use DRF ViewSet for CRUD resources" },
      { sourceConcept: "DbContext / EF Core",  targetConcept: "Django ORM / Model",       targetPackage: "django",              notes: "Django ORM built-in; define models.Model subclasses" },
      { sourceConcept: "DTO / record",         targetConcept: "Serializer",               targetPackage: "djangorestframework", notes: "DRF Serializer handles both validation and serialisation" },
      { sourceConcept: "IConfiguration",       targetConcept: "settings.py",              targetPackage: "django",              notes: "Use django-environ for env-based settings" },
      { sourceConcept: "Service class (DI)",   targetConcept: "Service module (no DI)",   targetPackage: "django",              notes: "Django uses no built-in DI; import service modules directly" },
      { sourceConcept: "EF Core Migrations",   targetConcept: "manage.py makemigrations", targetPackage: "django",              notes: "Django generates migration files automatically" },
    ],
    setupNotes: [
      "pip install django djangorestframework django-environ pytest-django",
      "Run with: python manage.py runserver",
    ],
    projectStructure: `
project/
├── manage.py
├── config/               # settings.py, urls.py, wsgi.py
├── apps/<app>/           # models.py, views.py, serializers.py, urls.py
├── tests/
└── requirements.txt`,
  },

  // ---------------------------------------------------------------------------
  // Spring Boot → FastAPI (Python)
  // ---------------------------------------------------------------------------
  {
    sourceFramework: "spring-boot",
    targetFramework: "fastapi",
    conceptMap: [
      { sourceConcept: "@RestController",    targetConcept: "APIRouter",              targetPackage: "fastapi",    notes: "Each @RestController becomes an APIRouter" },
      { sourceConcept: "@Service",           targetConcept: "Service class + Depends()", targetPackage: "fastapi", notes: "Inject with FastAPI Depends()" },
      { sourceConcept: "@Repository / JPA",  targetConcept: "Repository + SQLAlchemy Session", targetPackage: "sqlalchemy", notes: "" },
      { sourceConcept: "@Entity",            targetConcept: "SQLAlchemy ORM model",  targetPackage: "sqlalchemy", notes: "" },
      { sourceConcept: "application.properties", targetConcept: ".env + BaseSettings", targetPackage: "pydantic-settings", notes: "" },
      { sourceConcept: "Lombok @Data",       targetConcept: "Pydantic BaseModel",    targetPackage: "pydantic",   notes: "Pydantic generates __init__, validation, serialisation" },
      { sourceConcept: "@Autowired",         targetConcept: "Depends()",             targetPackage: "fastapi",    notes: "Constructor injection → FastAPI dependency injection" },
    ],
    setupNotes: [
      "pip install fastapi uvicorn sqlalchemy pydantic pydantic-settings alembic",
    ],
    projectStructure: `
project/
├── main.py
├── routers/
├── services/
├── repositories/
├── models/
├── schemas/
└── requirements.txt`,
  },

  // ---------------------------------------------------------------------------
  // Express (Node.js) → FastAPI (Python)
  // ---------------------------------------------------------------------------
  {
    sourceFramework: "express",
    targetFramework: "fastapi",
    conceptMap: [
      { sourceConcept: "express.Router()",  targetConcept: "APIRouter",             targetPackage: "fastapi",    notes: "" },
      { sourceConcept: "req.body / req.params", targetConcept: "Pydantic request model / Path/Query params", targetPackage: "fastapi", notes: "FastAPI parses and validates automatically" },
      { sourceConcept: "res.json()",        targetConcept: "return Pydantic model",  targetPackage: "fastapi",   notes: "" },
      { sourceConcept: "middleware (app.use)", targetConcept: "@app.middleware('http')", targetPackage: "fastapi", notes: "" },
      { sourceConcept: "Mongoose / Sequelize", targetConcept: "SQLAlchemy",         targetPackage: "sqlalchemy", notes: "" },
      { sourceConcept: ".env (dotenv)",     targetConcept: ".env + BaseSettings",   targetPackage: "pydantic-settings", notes: "" },
      { sourceConcept: "Jest",              targetConcept: "pytest",                targetPackage: "pytest",     notes: "" },
    ],
    setupNotes: [
      "pip install fastapi uvicorn sqlalchemy pydantic pydantic-settings pytest",
    ],
    projectStructure: `
project/
├── main.py
├── routers/
├── services/
├── models/
├── schemas/
└── requirements.txt`,
  },
];

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Look up the concept mapping for a given source → target framework pair */
export function getFrameworkMapping(
  sourceFramework: string,
  targetFramework: string
): FrameworkMapping | null {
  return (
    MAPPINGS.find(
      (m) =>
        m.sourceFramework === sourceFramework &&
        m.targetFramework === targetFramework
    ) ?? null
  );
}

/** Format the concept map as a prompt-friendly reference table */
export function formatMappingForPrompt(mapping: FrameworkMapping): string {
  const rows = mapping.conceptMap
    .map((c) => `  ${c.sourceConcept.padEnd(40)} → ${c.targetConcept} (${c.targetPackage})${c.notes ? `\n    Note: ${c.notes}` : ""}`)
    .join("\n");

  return [
    `Source framework: ${mapping.sourceFramework}`,
    `Target framework: ${mapping.targetFramework}`,
    ``,
    `Concept mapping:`,
    rows,
    ``,
    `Setup:`,
    mapping.setupNotes.map((n) => `  - ${n}`).join("\n"),
    ``,
    `Recommended project structure:`,
    mapping.projectStructure,
  ].join("\n");
}

/** Return all source frameworks that have at least one mapping */
export function supportedSourceFrameworks(): string[] {
  return [...new Set(MAPPINGS.map((m) => m.sourceFramework))];
}

/** Return all target frameworks available for a given source */
export function targetsFor(sourceFramework: string): string[] {
  return MAPPINGS.filter((m) => m.sourceFramework === sourceFramework).map(
    (m) => m.targetFramework
  );
}
