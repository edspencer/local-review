// orchard-api: the Go service. Base history (May–September 2026), Sam's webhook-retries stack (merged with merge
// commits; the archived project), Theo's calendar feed branch, and Maya's waitlists branch: its Groundwork stack
// squash-merged on GitHub, the rest rebased onto the new main, then "Promote the first waitlisted member" amended
// after review (one branch tag left behind: `moved`).
import { RepoBuilder, after, edits, replace, type Changes, type Commit } from '../lib/gitworld.ts';
import { at, june, maya, remote, sam, theo } from './people.ts';

const MOD = 'github.com/orchard-studio-demo/orchard-api';
const append = (s: string) => (old: string) => old + s;

export function buildApi() {
  const r = new RepoBuilder('orchard-api', remote('orchard-api'));

  // ---------------------------------------------------------------- base history
  const a1 = r.commit(null, 'Initial service skeleton', {
    'go.mod': `module ${MOD}

go 1.22

require github.com/go-chi/chi/v5 v5.0.12
`,
    'README.md': `# orchard-api

The HTTP API behind Orchard: studios publish a class schedule, members book spots in classes.

## Running locally

    docker compose up -d postgres
    make migrate
    make run

The API listens on \`:8080\` (set \`PORT\` to change it) and reads \`DATABASE_URL\`.

## Layout

- \`cmd/orchard-api\`: the server binary
- \`internal/httpapi\`: routing, auth and the JSON handlers
- \`internal/store\`: every SQL query, one file per table
- \`migrations\`: plain SQL, applied in order by \`make migrate\`
`,
    Makefile: `.PHONY: run test vet migrate

run:
    go run ./cmd/orchard-api

test:
    go test ./...

vet:
    go vet ./...

migrate:
    for f in migrations/*.sql; do psql "$$DATABASE_URL" -v ON_ERROR_STOP=1 -f $$f; done
`,
    'cmd/orchard-api/main.go': `package main

import (
    "context"
    "errors"
    "log/slog"
    "net/http"
    "os"
    "os/signal"
    "time"

    "${MOD}/internal/httpapi"
)

func main() {
    log := slog.New(slog.NewJSONHandler(os.Stdout, nil))
    ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt)
    defer stop()

    srv := &http.Server{
        Addr:              ":" + envOr("PORT", "8080"),
        Handler:           httpapi.NewRouter(log),
        ReadHeaderTimeout: 5 * time.Second,
    }
    go func() {
        <-ctx.Done()
        shutdown, cancel := context.WithTimeout(context.Background(), 10*time.Second)
        defer cancel()
        _ = srv.Shutdown(shutdown)
    }()
    log.Info("listening", "addr", srv.Addr)
    if err := srv.ListenAndServe(); !errors.Is(err, http.ErrServerClosed) {
        log.Error("serve", "err", err)
        os.Exit(1)
    }
}

func envOr(key, fallback string) string {
    if v := os.Getenv(key); v != "" {
        return v
    }
    return fallback
}
`,
    'internal/httpapi/router.go': `package httpapi

import (
    "log/slog"
    "net/http"

    "github.com/go-chi/chi/v5"
)

type handlers struct {
    log *slog.Logger
}

// NewRouter wires every route the API serves.
func NewRouter(log *slog.Logger) http.Handler {
    h := &handlers{log: log}
    r := chi.NewRouter()
    r.Get("/healthz", h.health)
    return r
}

func (h *handlers) health(w http.ResponseWriter, r *http.Request) {
    writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}
`,
    'internal/httpapi/respond.go': `package httpapi

import (
    "encoding/json"
    "net/http"
)

func writeJSON(w http.ResponseWriter, status int, v any) {
    w.Header().Set("Content-Type", "application/json")
    w.WriteHeader(status)
    _ = json.NewEncoder(w).Encode(v)
}

// writeError sends the API's error shape: {"error": {"code": "...", "message": "..."}}.
// Codes are stable and clients switch on them; messages are for people.
func writeError(w http.ResponseWriter, status int, code, message string) {
    writeJSON(w, status, map[string]any{"error": map[string]string{"code": code, "message": message}})
}
`,
  }, { author: theo, at: at('2026-05-04 09:20') });

  const a2 = r.commit(a1, 'Add the schema and a store for classes\n\nStudios, members, classes and bookings in one first migration; the store package owns every query.', {
    'go.mod': replace('require github.com/go-chi/chi/v5 v5.0.12\n', `require (
    github.com/go-chi/chi/v5 v5.0.12
    github.com/jackc/pgx/v5 v5.5.5
)
`),
    'migrations/0001_init.sql': `CREATE TABLE studios (
    id          bigserial PRIMARY KEY,
    name        text NOT NULL,
    timezone    text NOT NULL DEFAULT 'UTC'
);

CREATE TABLE members (
    id          bigserial PRIMARY KEY,
    studio_id   bigint NOT NULL REFERENCES studios (id),
    name        text NOT NULL,
    email       text NOT NULL,
    is_staff    boolean NOT NULL DEFAULT false,
    api_token   text UNIQUE,
    UNIQUE (studio_id, email)
);

CREATE TABLE classes (
    id          bigserial PRIMARY KEY,
    studio_id   bigint NOT NULL REFERENCES studios (id),
    title       text NOT NULL,
    coach       text NOT NULL,
    starts_at   timestamptz NOT NULL,
    minutes     integer NOT NULL CHECK (minutes > 0),
    capacity    integer NOT NULL CHECK (capacity > 0)
);

CREATE INDEX classes_schedule ON classes (studio_id, starts_at);

CREATE TABLE bookings (
    id          bigserial PRIMARY KEY,
    class_id    bigint NOT NULL REFERENCES classes (id) ON DELETE CASCADE,
    member_id   bigint NOT NULL REFERENCES members (id),
    status      text NOT NULL DEFAULT 'confirmed' CHECK (status IN ('confirmed', 'cancelled')),
    created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX bookings_class ON bookings (class_id) WHERE status = 'confirmed';
`,
    'internal/store/db.go': `package store

import (
    "context"
    "errors"

    "github.com/jackc/pgx/v5"
    "github.com/jackc/pgx/v5/pgxpool"
)

// ErrNotFound is returned when a row a caller asked for doesn't exist.
var ErrNotFound = errors.New("not found")

// DB is the API's handle on Postgres. Every query lives in this package, one file per table.
type DB struct {
    pool *pgxpool.Pool
}

func Open(ctx context.Context, url string) (*DB, error) {
    pool, err := pgxpool.New(ctx, url)
    if err != nil {
        return nil, err
    }
    if err := pool.Ping(ctx); err != nil {
        pool.Close()
        return nil, err
    }
    return &DB{pool: pool}, nil
}

func (db *DB) Close() { db.pool.Close() }

// Tx runs fn in a transaction, committing if it returns nil and rolling back otherwise.
func (db *DB) Tx(ctx context.Context, fn func(pgx.Tx) error) error {
    return pgx.BeginFunc(ctx, db.pool, fn)
}

func notFound(err error) error {
    if errors.Is(err, pgx.ErrNoRows) {
        return ErrNotFound
    }
    return err
}
`,
    'internal/store/classes.go': `package store

import (
    "context"
    "time"

    "github.com/jackc/pgx/v5"
)

type Class struct {
    ID       int64
    StudioID int64
    Title    string
    Coach    string
    StartsAt time.Time
    Minutes  int
    Capacity int
    Booked   int // confirmed bookings
}

const classColumns = \`c.id, c.studio_id, c.title, c.coach, c.starts_at, c.minutes, c.capacity,
    (SELECT count(*) FROM bookings b WHERE b.class_id = c.id AND b.status = 'confirmed')\`

func scanClass(row pgx.Row) (Class, error) {
    var c Class
    err := row.Scan(&c.ID, &c.StudioID, &c.Title, &c.Coach, &c.StartsAt, &c.Minutes, &c.Capacity, &c.Booked)
    return c, notFound(err)
}

// ClassesBetween lists a studio's classes starting in [from, to), earliest first.
func (db *DB) ClassesBetween(ctx context.Context, studioID int64, from, to time.Time) ([]Class, error) {
    rows, err := db.pool.Query(ctx, \`
        SELECT \`+classColumns+\`
        FROM classes c
        WHERE c.studio_id = $1 AND c.starts_at >= $2 AND c.starts_at < $3
        ORDER BY c.starts_at\`, studioID, from, to)
    if err != nil {
        return nil, err
    }
    return pgx.CollectRows(rows, func(row pgx.CollectableRow) (Class, error) { return scanClass(row) })
}

func (db *DB) Class(ctx context.Context, id int64) (Class, error) {
    return scanClass(db.pool.QueryRow(ctx, \`SELECT \`+classColumns+\` FROM classes c WHERE c.id = $1\`, id))
}

// LockClass reads a class and locks its row until the transaction ends. Anything that hands out
// spots in a class takes this lock first, so two requests can't both see the same free spot.
func LockClass(ctx context.Context, tx pgx.Tx, id int64) (Class, error) {
    return scanClass(tx.QueryRow(ctx, \`SELECT \`+classColumns+\` FROM classes c WHERE c.id = $1 FOR UPDATE OF c\`, id))
}
`,
    'internal/store/members.go': `package store

import "context"

type Member struct {
    ID       int64
    StudioID int64
    Name     string
    Email    string
    IsStaff  bool
}

// MemberByToken finds the member an API token belongs to.
func (db *DB) MemberByToken(ctx context.Context, token string) (Member, error) {
    var m Member
    err := db.pool.QueryRow(ctx, \`
        SELECT id, studio_id, name, email, is_staff FROM members WHERE api_token = $1\`, token,
    ).Scan(&m.ID, &m.StudioID, &m.Name, &m.Email, &m.IsStaff)
    return m, notFound(err)
}

func (db *DB) Member(ctx context.Context, id int64) (Member, error) {
    var m Member
    err := db.pool.QueryRow(ctx, \`
        SELECT id, studio_id, name, email, is_staff FROM members WHERE id = $1\`, id,
    ).Scan(&m.ID, &m.StudioID, &m.Name, &m.Email, &m.IsStaff)
    return m, notFound(err)
}
`,
    'cmd/orchard-api/main.go': edits(
      ['    "time"\n\n    "' + MOD + '/internal/httpapi"\n', '    "time"\n\n    "' + MOD + '/internal/httpapi"\n    "' + MOD + '/internal/store"\n'],
      [
        '    srv := &http.Server{\n',
        `    db, err := store.Open(ctx, os.Getenv("DATABASE_URL"))
    if err != nil {
        log.Error("open database", "err", err)
        os.Exit(1)
    }
    defer db.Close()

    srv := &http.Server{
`,
      ],
      ['httpapi.NewRouter(log)', 'httpapi.NewRouter(db, log)'],
    ),
    'internal/httpapi/router.go': edits(
      ['    "github.com/go-chi/chi/v5"\n)', '    "github.com/go-chi/chi/v5"\n\n    "' + MOD + '/internal/store"\n)'],
      ['type handlers struct {\n    log *slog.Logger\n}', 'type handlers struct {\n    db  *store.DB\n    log *slog.Logger\n}'],
      ['func NewRouter(log *slog.Logger) http.Handler {\n    h := &handlers{log: log}', 'func NewRouter(db *store.DB, log *slog.Logger) http.Handler {\n    h := &handlers{db: db, log: log}'],
    ),
  }, { author: theo, at: at('2026-05-11 14:05') });

  const a3 = r.commit(a2, 'Add the schedule and class endpoints', {
    'internal/httpapi/classes.go': `package httpapi

import (
    "errors"
    "net/http"
    "time"

    "${MOD}/internal/store"
)

type classJSON struct {
    ID        int64     \`json:"id"\`
    Title     string    \`json:"title"\`
    Coach     string    \`json:"coach"\`
    StartsAt  time.Time \`json:"starts_at"\`
    Minutes   int       \`json:"minutes"\`
    Capacity  int       \`json:"capacity"\`
    SpotsLeft int       \`json:"spots_left"\`
}

func toClassJSON(c store.Class) classJSON {
    return classJSON{
        ID: c.ID, Title: c.Title, Coach: c.Coach, StartsAt: c.StartsAt, Minutes: c.Minutes,
        Capacity: c.Capacity, SpotsLeft: max(c.Capacity-c.Booked, 0),
    }
}

// GET /studios/{studio}/schedule?from=2026-05-18 lists a week of classes.
func (h *handlers) schedule(w http.ResponseWriter, r *http.Request) {
    studio, ok := pathID(w, r, "studio")
    if !ok {
        return
    }
    from, err := time.Parse(time.DateOnly, r.URL.Query().Get("from"))
    if err != nil {
        from = time.Now().UTC().Truncate(24 * time.Hour)
    }
    classes, err := h.db.ClassesBetween(r.Context(), studio, from, from.AddDate(0, 0, 7))
    if err != nil {
        h.fail(w, r, err)
        return
    }
    out := make([]classJSON, 0, len(classes))
    for _, c := range classes {
        out = append(out, toClassJSON(c))
    }
    writeJSON(w, http.StatusOK, map[string]any{"classes": out})
}

// GET /classes/{id}
func (h *handlers) class(w http.ResponseWriter, r *http.Request) {
    id, ok := pathID(w, r, "id")
    if !ok {
        return
    }
    c, err := h.db.Class(r.Context(), id)
    if errors.Is(err, store.ErrNotFound) {
        writeError(w, http.StatusNotFound, "not_found", "No such class.")
        return
    }
    if err != nil {
        h.fail(w, r, err)
        return
    }
    writeJSON(w, http.StatusOK, toClassJSON(c))
}
`,
    'internal/httpapi/auth.go': `package httpapi

import (
    "context"
    "net/http"
    "strings"

    "${MOD}/internal/store"
)

type memberKey struct{}

// authenticate resolves the bearer token to a member, or answers 401.
func (h *handlers) authenticate(next http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        token, ok := strings.CutPrefix(r.Header.Get("Authorization"), "Bearer ")
        if !ok || token == "" {
            writeError(w, http.StatusUnauthorized, "unauthenticated", "Sign in to continue.")
            return
        }
        m, err := h.db.MemberByToken(r.Context(), token)
        if err != nil {
            writeError(w, http.StatusUnauthorized, "unauthenticated", "Your session has expired. Sign in again.")
            return
        }
        next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), memberKey{}, m)))
    })
}

func memberFrom(ctx context.Context) store.Member {
    return ctx.Value(memberKey{}).(store.Member)
}
`,
    'internal/httpapi/respond.go': edits(
      ['    "encoding/json"\n    "net/http"\n)', '    "encoding/json"\n    "net/http"\n    "strconv"\n\n    "github.com/go-chi/chi/v5"\n)'],
      [
        '    writeJSON(w, status, map[string]any{"error": map[string]string{"code": code, "message": message}})\n}\n',
        `    writeJSON(w, status, map[string]any{"error": map[string]string{"code": code, "message": message}})
}

// pathID reads a numeric URL parameter, answering 404 if it isn't one.
func pathID(w http.ResponseWriter, r *http.Request, name string) (int64, bool) {
    id, err := strconv.ParseInt(chi.URLParam(r, name), 10, 64)
    if err != nil || id <= 0 {
        writeError(w, http.StatusNotFound, "not_found", "Not found.")
        return 0, false
    }
    return id, true
}

// fail logs an unexpected error and answers 500 without leaking it.
func (h *handlers) fail(w http.ResponseWriter, r *http.Request, err error) {
    h.log.ErrorContext(r.Context(), "request failed", "method", r.Method, "path", r.URL.Path, "err", err)
    writeError(w, http.StatusInternalServerError, "internal", "Something went wrong on our side.")
}
`,
      ],
    ),
    'internal/httpapi/router.go': replace(
      '    r.Get("/healthz", h.health)\n',
      `    r.Get("/healthz", h.health)

    r.Group(func(r chi.Router) {
        r.Use(h.authenticate)
        r.Get("/studios/{studio}/schedule", h.schedule)
        r.Get("/classes/{id}", h.class)
    })
`,
    ),
  }, { author: june, at: at('2026-05-19 11:42') });

  const a4 = r.commit(a3, 'Add bookings with a capacity check\n\nBooking locks the class row, so two members racing for the last spot can\'t both get it.', {
    'internal/store/bookings.go': `package store

import (
    "context"
    "time"

    "github.com/jackc/pgx/v5"
)

type Booking struct {
    ID        int64
    ClassID   int64
    MemberID  int64
    Status    string // confirmed | cancelled
    CreatedAt time.Time
}

// CountBookings counts a class's confirmed bookings.
func CountBookings(ctx context.Context, tx pgx.Tx, classID int64) (int, error) {
    var n int
    err := tx.QueryRow(ctx, \`SELECT count(*) FROM bookings WHERE class_id = $1 AND status = 'confirmed'\`, classID).Scan(&n)
    return n, err
}

// HasBooking reports whether a member already holds a confirmed spot in a class.
func HasBooking(ctx context.Context, tx pgx.Tx, classID, memberID int64) (bool, error) {
    var ok bool
    err := tx.QueryRow(ctx, \`
        SELECT EXISTS (SELECT 1 FROM bookings WHERE class_id = $1 AND member_id = $2 AND status = 'confirmed')\`,
        classID, memberID).Scan(&ok)
    return ok, err
}

func CreateBooking(ctx context.Context, tx pgx.Tx, classID, memberID int64) (Booking, error) {
    b := Booking{ClassID: classID, MemberID: memberID, Status: "confirmed"}
    err := tx.QueryRow(ctx, \`
        INSERT INTO bookings (class_id, member_id) VALUES ($1, $2)
        RETURNING id, created_at\`, classID, memberID).Scan(&b.ID, &b.CreatedAt)
    return b, err
}

// MemberBooking is a booking with its class, for "My bookings".
type MemberBooking struct {
    Booking
    Class Class
}

// MemberBookings lists a member's confirmed bookings for classes starting after since, soonest first.
func (db *DB) MemberBookings(ctx context.Context, memberID int64, since time.Time) ([]MemberBooking, error) {
    rows, err := db.pool.Query(ctx, \`
        SELECT b.id, b.class_id, b.member_id, b.status, b.created_at, \`+classColumns+\`
        FROM bookings b JOIN classes c ON c.id = b.class_id
        WHERE b.member_id = $1 AND b.status = 'confirmed' AND c.starts_at >= $2
        ORDER BY c.starts_at\`, memberID, since)
    if err != nil {
        return nil, err
    }
    return pgx.CollectRows(rows, func(row pgx.CollectableRow) (MemberBooking, error) {
        var mb MemberBooking
        c := &mb.Class
        err := row.Scan(&mb.ID, &mb.ClassID, &mb.MemberID, &mb.Status, &mb.CreatedAt,
            &c.ID, &c.StudioID, &c.Title, &c.Coach, &c.StartsAt, &c.Minutes, &c.Capacity, &c.Booked)
        return mb, err
    })
}
`,
    'internal/booking/service.go': `// Package booking holds the rules for handing out spots in classes.
package booking

import (
    "context"
    "errors"
    "time"

    "github.com/jackc/pgx/v5"

    "${MOD}/internal/store"
)

var (
    ErrClassFull     = errors.New("class is full")
    ErrAlreadyBooked = errors.New("already booked")
)

type Service struct {
    db  *store.DB
    now func() time.Time
}

func NewService(db *store.DB) *Service {
    return &Service{db: db, now: time.Now}
}

// Book gives a member a spot in a class, if there's one free.
func (s *Service) Book(ctx context.Context, classID, memberID int64) (store.Booking, error) {
    var b store.Booking
    err := s.db.Tx(ctx, func(tx pgx.Tx) error {
        class, err := store.LockClass(ctx, tx, classID)
        if err != nil {
            return err
        }
        booked, err := store.HasBooking(ctx, tx, classID, memberID)
        if err != nil {
            return err
        }
        if booked {
            return ErrAlreadyBooked
        }
        n, err := store.CountBookings(ctx, tx, classID)
        if err != nil {
            return err
        }
        if n >= class.Capacity {
            return ErrClassFull
        }
        b, err = store.CreateBooking(ctx, tx, classID, memberID)
        return err
    })
    return b, err
}
`,
    'internal/httpapi/bookings.go': `package httpapi

import (
    "errors"
    "net/http"
    "time"

    "${MOD}/internal/booking"
    "${MOD}/internal/store"
)

type bookingJSON struct {
    ID      int64      \`json:"id"\`
    ClassID int64      \`json:"class_id"\`
    Status  string     \`json:"status"\`
    Class   *classJSON \`json:"class,omitempty"\`
}

func toBookingJSON(b store.Booking) bookingJSON {
    return bookingJSON{ID: b.ID, ClassID: b.ClassID, Status: b.Status}
}

// POST /classes/{id}/bookings
func (h *handlers) book(w http.ResponseWriter, r *http.Request) {
    classID, ok := pathID(w, r, "id")
    if !ok {
        return
    }
    b, err := h.bookings.Book(r.Context(), classID, memberFrom(r.Context()).ID)
    switch {
    case errors.Is(err, store.ErrNotFound):
        writeError(w, http.StatusNotFound, "not_found", "No such class.")
    case errors.Is(err, booking.ErrClassFull):
        writeError(w, http.StatusConflict, "class_full", "This class is full.")
    case errors.Is(err, booking.ErrAlreadyBooked):
        writeError(w, http.StatusConflict, "already_booked", "You already have a spot in this class.")
    case err != nil:
        h.fail(w, r, err)
    default:
        writeJSON(w, http.StatusCreated, toBookingJSON(b))
    }
}

// GET /me/bookings lists the member's upcoming bookings.
func (h *handlers) myBookings(w http.ResponseWriter, r *http.Request) {
    list, err := h.db.MemberBookings(r.Context(), memberFrom(r.Context()).ID, time.Now())
    if err != nil {
        h.fail(w, r, err)
        return
    }
    out := make([]bookingJSON, 0, len(list))
    for _, mb := range list {
        b := toBookingJSON(mb.Booking)
        c := toClassJSON(mb.Class)
        b.Class = &c
        out = append(out, b)
    }
    writeJSON(w, http.StatusOK, map[string]any{"bookings": out})
}
`,
    'internal/httpapi/router.go': edits(
      ['    "' + MOD + '/internal/store"\n)', '    "' + MOD + '/internal/booking"\n    "' + MOD + '/internal/store"\n)'],
      ['type handlers struct {\n    db  *store.DB\n    log *slog.Logger\n}', 'type handlers struct {\n    db       *store.DB\n    bookings *booking.Service\n    log      *slog.Logger\n}'],
      ['func NewRouter(db *store.DB, log *slog.Logger) http.Handler {\n    h := &handlers{db: db, log: log}', 'func NewRouter(db *store.DB, bookings *booking.Service, log *slog.Logger) http.Handler {\n    h := &handlers{db: db, bookings: bookings, log: log}'],
      ['        r.Get("/classes/{id}", h.class)\n', '        r.Get("/classes/{id}", h.class)\n        r.Post("/classes/{id}/bookings", h.book)\n        r.Get("/me/bookings", h.myBookings)\n'],
    ),
    'cmd/orchard-api/main.go': edits(
      ['    "' + MOD + '/internal/httpapi"\n', '    "' + MOD + '/internal/booking"\n    "' + MOD + '/internal/httpapi"\n'],
      ['httpapi.NewRouter(db, log)', 'httpapi.NewRouter(db, booking.NewService(db), log)'],
    ),
    'README.md': replace("- `internal/httpapi`: routing, auth and the JSON handlers\n", "- `internal/httpapi`: routing, auth and the JSON handlers\n- `internal/booking`: the booking rules (capacity, who gets a spot)\n"),
  }, { author: theo, at: at('2026-05-27 16:31') });

  const a5 = r.commit(a4, 'Run tests and vet in CI', {
    '.github/workflows/ci.yml': `name: ci
on:
  pull_request:
  push:
    branches: [main]

jobs:
  test:
    runs-on: ubuntu-latest
    services:
      postgres:
        image: postgres:16
        env:
          POSTGRES_PASSWORD: postgres
        ports: ["5432:5432"]
        options: --health-cmd pg_isready --health-interval 5s --health-retries 10
    env:
      TEST_DATABASE_URL: postgres://postgres:postgres@localhost:5432/postgres?sslmode=disable
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-go@v5
        with:
          go-version: "1.22"
      - run: for f in migrations/*.sql; do psql "$TEST_DATABASE_URL" -v ON_ERROR_STOP=1 -f $f; done
      - run: go vet ./...
      - run: go test -race ./...
`,
  }, { author: june, at: at('2026-06-02 10:15') });

  const a6 = r.commit(a5, 'Add booking service tests', {
    'internal/store/storetest/storetest.go': `// Package storetest gives tests a real Postgres (TEST_DATABASE_URL) with throwaway rows.
package storetest

import (
    "context"
    "fmt"
    "os"
    "sync/atomic"
    "testing"
    "time"

    "github.com/jackc/pgx/v5"

    "${MOD}/internal/store"
)

var seq atomic.Int64

// New connects to the test database, skipping the test if there isn't one.
func New(t *testing.T) *store.DB {
    t.Helper()
    url := os.Getenv("TEST_DATABASE_URL")
    if url == "" {
        t.Skip("TEST_DATABASE_URL not set")
    }
    db, err := store.Open(context.Background(), url)
    if err != nil {
        t.Fatal(err)
    }
    t.Cleanup(db.Close)
    return db
}

func exec(t *testing.T, sql string, args ...any) int64 {
    t.Helper()
    conn, err := pgx.Connect(context.Background(), os.Getenv("TEST_DATABASE_URL"))
    if err != nil {
        t.Fatal(err)
    }
    defer conn.Close(context.Background())
    var id int64
    if err := conn.QueryRow(context.Background(), sql, args...).Scan(&id); err != nil {
        t.Fatal(err)
    }
    return id
}

// Class creates a class tomorrow, in a new studio, with the given capacity.
func Class(t *testing.T, db *store.DB, capacity int) store.Class {
    t.Helper()
    studio := exec(t, \`INSERT INTO studios (name) VALUES ('Test studio') RETURNING id\`)
    id := exec(t, \`
        INSERT INTO classes (studio_id, title, coach, starts_at, minutes, capacity)
        VALUES ($1, 'Vinyasa flow', 'Test coach', $2, 60, $3) RETURNING id\`,
        studio, time.Now().Add(24*time.Hour), capacity)
    c, err := db.Class(context.Background(), id)
    if err != nil {
        t.Fatal(err)
    }
    return c
}

// Member creates a member with a unique email.
func Member(t *testing.T, db *store.DB) store.Member {
    t.Helper()
    n := seq.Add(1)
    studio := exec(t, \`INSERT INTO studios (name) VALUES ('Test studio') RETURNING id\`)
    id := exec(t, \`INSERT INTO members (studio_id, name, email) VALUES ($1, $2, $3) RETURNING id\`,
        studio, fmt.Sprintf("Member %d", n), fmt.Sprintf("member%d@test.invalid", n))
    m, err := db.Member(context.Background(), id)
    if err != nil {
        t.Fatal(err)
    }
    return m
}
`,
    'internal/booking/service_test.go': `package booking_test

import (
    "context"
    "errors"
    "testing"

    "${MOD}/internal/booking"
    "${MOD}/internal/store/storetest"
)

var ctx = context.Background()

func TestBookTakesASpot(t *testing.T) {
    db := storetest.New(t)
    svc := booking.NewService(db)
    class := storetest.Class(t, db, 2)
    m := storetest.Member(t, db)

    if _, err := svc.Book(ctx, class.ID, m.ID); err != nil {
        t.Fatal(err)
    }
    if _, err := svc.Book(ctx, class.ID, m.ID); !errors.Is(err, booking.ErrAlreadyBooked) {
        t.Fatalf("second booking: got %v, want ErrAlreadyBooked", err)
    }
}

func TestBookRefusesAFullClass(t *testing.T) {
    db := storetest.New(t)
    svc := booking.NewService(db)
    class := storetest.Class(t, db, 1)

    if _, err := svc.Book(ctx, class.ID, storetest.Member(t, db).ID); err != nil {
        t.Fatal(err)
    }
    if _, err := svc.Book(ctx, class.ID, storetest.Member(t, db).ID); !errors.Is(err, booking.ErrClassFull) {
        t.Fatalf("got %v, want ErrClassFull", err)
    }
}
`,
  }, { author: sam, at: at('2026-06-09 15:48') });

  const a7 = r.commit(a6, 'Let members cancel a booking', {
    'internal/store/bookings.go': after(
      '    return b, err\n}\n',
      `
// CancelBooking cancels a member's confirmed booking. Someone else's booking is ErrNotFound.
func CancelBooking(ctx context.Context, tx pgx.Tx, id, memberID int64) (Booking, error) {
    b := Booking{ID: id, MemberID: memberID, Status: "cancelled"}
    err := tx.QueryRow(ctx, \`
        UPDATE bookings SET status = 'cancelled'
        WHERE id = $1 AND member_id = $2 AND status = 'confirmed'
        RETURNING class_id, created_at\`, id, memberID).Scan(&b.ClassID, &b.CreatedAt)
    return b, notFound(err)
}
`,
    ),
    'internal/booking/service.go': append(`
// Cancel cancels one of a member's bookings, freeing the spot.
func (s *Service) Cancel(ctx context.Context, bookingID, memberID int64) error {
    return s.db.Tx(ctx, func(tx pgx.Tx) error {
        _, err := store.CancelBooking(ctx, tx, bookingID, memberID)
        return err
    })
}
`),
    'internal/httpapi/bookings.go': append(`
// DELETE /me/bookings/{id}
func (h *handlers) cancelBooking(w http.ResponseWriter, r *http.Request) {
    id, ok := pathID(w, r, "id")
    if !ok {
        return
    }
    err := h.bookings.Cancel(r.Context(), id, memberFrom(r.Context()).ID)
    switch {
    case errors.Is(err, store.ErrNotFound):
        writeError(w, http.StatusNotFound, "not_found", "No such booking.")
    case err != nil:
        h.fail(w, r, err)
    default:
        w.WriteHeader(http.StatusNoContent)
    }
}
`),
    'internal/httpapi/router.go': after('        r.Get("/me/bookings", h.myBookings)\n', '        r.Delete("/me/bookings/{id}", h.cancelBooking)\n'),
  }, { author: maya, at: at('2026-06-23 13:07') });

  const a8 = r.commit(a7, 'Email members when a booking is confirmed', {
    'internal/notify/notify.go': `// Package notify sends members messages: booking confirmations, offers from the waitlist.
package notify

import "context"

type Message struct {
    MemberID int64
    Subject  string
    Body     string
}

type Notifier interface {
    Notify(ctx context.Context, m Message) error
}

// Discard drops every message (tests, local runs without SMTP).
var Discard Notifier = discard{}

type discard struct{}

func (discard) Notify(context.Context, Message) error { return nil }
`,
    'internal/notify/email.go': `package notify

import (
    "context"
    "fmt"
    "net/smtp"

    "${MOD}/internal/store"
)

// Email sends messages over SMTP to the member's address.
type Email struct {
    db   *store.DB
    addr string
    from string
}

func NewEmail(db *store.DB, addr, from string) *Email {
    return &Email{db: db, addr: addr, from: from}
}

func (e *Email) Notify(ctx context.Context, m Message) error {
    member, err := e.db.Member(ctx, m.MemberID)
    if err != nil {
        return fmt.Errorf("notify member %d: %w", m.MemberID, err)
    }
    msg := fmt.Sprintf("From: %s\\r\\nTo: %s\\r\\nSubject: %s\\r\\n\\r\\n%s", e.from, member.Email, m.Subject, m.Body)
    return smtp.SendMail(e.addr, nil, e.from, []string{member.Email}, []byte(msg))
}
`,
    'internal/booking/service.go': edits(
      ['    "' + MOD + '/internal/store"\n)', '    "' + MOD + '/internal/notify"\n    "' + MOD + '/internal/store"\n)'],
      ['type Service struct {\n    db  *store.DB\n    now func() time.Time\n}', 'type Service struct {\n    db     *store.DB\n    notify notify.Notifier\n    now    func() time.Time\n}'],
      ['func NewService(db *store.DB) *Service {\n    return &Service{db: db, now: time.Now}', 'func NewService(db *store.DB, n notify.Notifier) *Service {\n    return &Service{db: db, notify: n, now: time.Now}'],
      [
        '        b, err = store.CreateBooking(ctx, tx, classID, memberID)\n        return err\n    })\n    return b, err\n}',
        `        b, err = store.CreateBooking(ctx, tx, classID, memberID)
        return err
    })
    if err != nil {
        return b, err
    }
    // after the commit: a failed email shouldn't undo the booking
    _ = s.notify.Notify(ctx, notify.Message{MemberID: memberID, Subject: "You're booked in", Body: "See you in class."})
    return b, nil
}`,
      ],
    ),
    'internal/booking/service_test.go': edits(
      ['    "' + MOD + '/internal/booking"\n', '    "' + MOD + '/internal/booking"\n    "' + MOD + '/internal/notify"\n'],
      ['func TestBookTakesASpot(t *testing.T) {\n    db := storetest.New(t)\n    svc := booking.NewService(db)', 'func TestBookTakesASpot(t *testing.T) {\n    db := storetest.New(t)\n    svc := booking.NewService(db, notify.Discard)'],
      ['func TestBookRefusesAFullClass(t *testing.T) {\n    db := storetest.New(t)\n    svc := booking.NewService(db)', 'func TestBookRefusesAFullClass(t *testing.T) {\n    db := storetest.New(t)\n    svc := booking.NewService(db, notify.Discard)'],
    ),
    'cmd/orchard-api/main.go': edits(
      ['    "' + MOD + '/internal/httpapi"\n', '    "' + MOD + '/internal/httpapi"\n    "' + MOD + '/internal/notify"\n'],
      [
        '    defer db.Close()\n\n',
        `    defer db.Close()

    mailer := notify.NewEmail(db, envOr("SMTP_ADDR", "localhost:1025"), envOr("MAIL_FROM", "bookings@orchard.example"))
    bookings := booking.NewService(db, mailer)

`,
      ],
      ['httpapi.NewRouter(db, booking.NewService(db), log)', 'httpapi.NewRouter(db, bookings, log)'],
    ),
  }, { author: sam, at: at('2026-07-07 10:52') });

  const a9 = r.commit(a8, 'Accept payment webhooks from the processor', {
    'internal/payments/webhook.go': `// Package payments handles the payment processor's webhooks.
package payments

import (
    "crypto/hmac"
    "crypto/sha256"
    "encoding/hex"
    "encoding/json"
    "errors"
    "strconv"
    "strings"
    "time"
)

// Event is the part of a processor webhook we use.
type Event struct {
    ID   string          \`json:"id"\`
    Type string          \`json:"type"\` // payment.succeeded, payment.refunded, ...
    Data json.RawMessage \`json:"data"\`
}

var ErrBadSignature = errors.New("bad webhook signature")

// Verify checks the processor's signature header, "t=<unix>,v1=<hex hmac>", where the HMAC is
// SHA-256 of "<t>.<body>". Signatures older than five minutes are refused (replays).
func Verify(secret []byte, header string, body []byte, now time.Time) error {
    var ts, sig string
    for _, part := range strings.Split(header, ",") {
        k, v, _ := strings.Cut(part, "=")
        switch k {
        case "t":
            ts = v
        case "v1":
            sig = v
        }
    }
    unix, err := strconv.ParseInt(ts, 10, 64)
    if err != nil || now.Sub(time.Unix(unix, 0)) > 5*time.Minute {
        return ErrBadSignature
    }
    mac := hmac.New(sha256.New, secret)
    mac.Write([]byte(ts + "."))
    mac.Write(body)
    want, err := hex.DecodeString(sig)
    if err != nil || !hmac.Equal(mac.Sum(nil), want) {
        return ErrBadSignature
    }
    return nil
}
`,
    'internal/httpapi/webhooks.go': `package httpapi

import (
    "encoding/json"
    "io"
    "net/http"
    "os"
    "time"

    "${MOD}/internal/payments"
)

var webhookSecret = []byte(os.Getenv("PAYMENTS_WEBHOOK_SECRET"))

// POST /webhooks/payments
func (h *handlers) paymentWebhook(w http.ResponseWriter, r *http.Request) {
    body, err := io.ReadAll(io.LimitReader(r.Body, 1<<20))
    if err != nil {
        writeError(w, http.StatusBadRequest, "bad_request", "Unreadable body.")
        return
    }
    if err := payments.Verify(webhookSecret, r.Header.Get("Processor-Signature"), body, time.Now()); err != nil {
        writeError(w, http.StatusUnauthorized, "bad_signature", "Signature check failed.")
        return
    }
    var e payments.Event
    if err := json.Unmarshal(body, &e); err != nil {
        writeError(w, http.StatusBadRequest, "bad_request", "Not a webhook event.")
        return
    }
    if err := h.db.ApplyPaymentEvent(r.Context(), e.ID, e.Type, e.Data); err != nil {
        h.fail(w, r, err)
        return
    }
    w.WriteHeader(http.StatusNoContent)
}
`,
    'internal/store/payments.go': `package store

import (
    "context"
    "encoding/json"
)

// ApplyPaymentEvent records what a payment event means for the member's credits. Unknown event
// types are ignored, so the processor adding new ones doesn't break us.
func (db *DB) ApplyPaymentEvent(ctx context.Context, eventID, kind string, data json.RawMessage) error {
    var p struct {
        MemberID int64 \`json:"member_ref,string"\`
        Credits  int   \`json:"credits"\`
    }
    if err := json.Unmarshal(data, &p); err != nil {
        return err
    }
    switch kind {
    case "payment.succeeded":
        _, err := db.pool.Exec(ctx, \`UPDATE members SET credits = credits + $2 WHERE id = $1\`, p.MemberID, p.Credits)
        return err
    case "payment.refunded":
        _, err := db.pool.Exec(ctx, \`UPDATE members SET credits = greatest(credits - $2, 0) WHERE id = $1\`, p.MemberID, p.Credits)
        return err
    }
    return nil
}
`,
    'internal/httpapi/router.go': after('    r.Get("/healthz", h.health)\n', '    r.Post("/webhooks/payments", h.paymentWebhook)\n'),
  }, { author: sam, at: at('2026-07-21 17:20') });

  // Sam's webhook-retries stack (the archived project): three stacked PRs, merged on GitHub with merge commits.
  const h1 = r.commit(a9, 'Record webhook deliveries before processing them\n\nEvery delivery is stored first and processed second, so a failure in processing never loses an event\nand a redelivery of the same event id is a no-op.', {
    'migrations/0003_webhook_deliveries.sql': `CREATE TABLE webhook_deliveries (
    event_id     text PRIMARY KEY,
    kind         text NOT NULL,
    payload      jsonb NOT NULL,
    received_at  timestamptz NOT NULL DEFAULT now(),
    processed_at timestamptz,
    attempts     integer NOT NULL DEFAULT 0,
    last_attempt_at timestamptz,
    last_error   text
);

CREATE INDEX webhook_deliveries_pending ON webhook_deliveries (received_at) WHERE processed_at IS NULL;
`,
    'internal/store/deliveries.go': `package store

import (
    "context"
    "encoding/json"
)

// RecordDelivery stores a webhook delivery. It reports false for an event id we've already stored
// (the processor redelivers on timeouts).
func (db *DB) RecordDelivery(ctx context.Context, eventID, kind string, payload json.RawMessage) (bool, error) {
    tag, err := db.pool.Exec(ctx, \`
        INSERT INTO webhook_deliveries (event_id, kind, payload) VALUES ($1, $2, $3)
        ON CONFLICT (event_id) DO NOTHING\`, eventID, kind, payload)
    return tag.RowsAffected() == 1, err
}

// MarkDelivery records the outcome of one processing attempt.
func (db *DB) MarkDelivery(ctx context.Context, eventID string, procErr error) error {
    if procErr == nil {
        _, err := db.pool.Exec(ctx, \`
            UPDATE webhook_deliveries SET processed_at = now(), attempts = attempts + 1, last_attempt_at = now(), last_error = NULL
            WHERE event_id = $1\`, eventID)
        return err
    }
    _, err := db.pool.Exec(ctx, \`
        UPDATE webhook_deliveries SET attempts = attempts + 1, last_attempt_at = now(), last_error = $2 WHERE event_id = $1\`,
        eventID, procErr.Error())
    return err
}
`,
    'internal/httpapi/webhooks.go': replace(
      `    if err := h.db.ApplyPaymentEvent(r.Context(), e.ID, e.Type, e.Data); err != nil {
        h.fail(w, r, err)
        return
    }
    w.WriteHeader(http.StatusNoContent)`,
      `    fresh, err := h.db.RecordDelivery(r.Context(), e.ID, e.Type, body)
    if err != nil {
        h.fail(w, r, err)
        return
    }
    // stored: from here on a failure is ours to retry, not the processor's
    w.WriteHeader(http.StatusNoContent)
    if fresh {
        perr := h.db.ApplyPaymentEvent(r.Context(), e.ID, e.Type, e.Data)
        if err := h.db.MarkDelivery(r.Context(), e.ID, perr); err != nil {
            h.log.ErrorContext(r.Context(), "mark delivery", "event", e.ID, "err", err)
        }
    }`,
    ),
  }, { author: sam, at: at('2026-07-28 11:03') });

  const h2 = r.commit(h1, 'Retry failed deliveries with exponential backoff', {
    'internal/payments/retry.go': `package payments

import (
    "context"
    "log/slog"
    "time"

    "${MOD}/internal/store"
)

// MaxAttempts is when we stop retrying a delivery and leave it for a person (the dead-letter list).
const MaxAttempts = 8

// Backoff is the wait before attempt n+1: 30s, 1m, 2m, 4m ... capped at 1h.
func Backoff(attempts int) time.Duration {
    d := 30 * time.Second << min(max(attempts-1, 0), 7)
    return min(d, time.Hour)
}

// RetryLoop reprocesses failed deliveries until ctx ends.
func RetryLoop(ctx context.Context, db *store.DB, log *slog.Logger) {
    tick := time.NewTicker(15 * time.Second)
    defer tick.Stop()
    for {
        select {
        case <-ctx.Done():
            return
        case <-tick.C:
        }
        due, err := db.DueDeliveries(ctx, time.Now(), MaxAttempts, Backoff)
        if err != nil {
            log.Error("list due deliveries", "err", err)
            continue
        }
        for _, d := range due {
            perr := db.ApplyPaymentEvent(ctx, d.EventID, d.Kind, d.Payload)
            if err := db.MarkDelivery(ctx, d.EventID, perr); err != nil {
                log.Error("mark delivery", "event", d.EventID, "err", err)
            }
        }
    }
}
`,
    'internal/payments/retry_test.go': `package payments

import (
    "testing"
    "time"
)

func TestBackoff(t *testing.T) {
    for attempts, want := range map[int]time.Duration{
        1: 30 * time.Second,
        2: time.Minute,
        4: 4 * time.Minute,
        7: 32 * time.Minute,
        8: time.Hour,
        30: time.Hour,
    } {
        if got := Backoff(attempts); got != want {
            t.Errorf("Backoff(%d) = %v, want %v", attempts, got, want)
        }
    }
}
`,
    'internal/store/deliveries.go': edits(
      ['import (\n    "context"\n    "encoding/json"\n)', 'import (\n    "context"\n    "encoding/json"\n    "time"\n)'],
      [
        '// MarkDelivery records',
        `type Delivery struct {
    EventID  string
    Kind     string
    Payload  []byte
    Attempts int
}

// DueDeliveries lists unprocessed deliveries whose backoff has passed and that haven't run out of attempts.
func (db *DB) DueDeliveries(ctx context.Context, now time.Time, maxAttempts int, backoff func(int) time.Duration) ([]Delivery, error) {
    rows, err := db.pool.Query(ctx, \`
        SELECT event_id, kind, payload, attempts, coalesce(last_attempt_at, received_at) FROM webhook_deliveries
        WHERE processed_at IS NULL AND attempts BETWEEN 1 AND $1 - 1
        ORDER BY received_at LIMIT 100\`, maxAttempts)
    if err != nil {
        return nil, err
    }
    var due []Delivery
    for rows.Next() {
        var d Delivery
        var last time.Time
        if err := rows.Scan(&d.EventID, &d.Kind, &d.Payload, &d.Attempts, &last); err != nil {
            return nil, err
        }
        if now.Sub(last) >= backoff(d.Attempts) {
            due = append(due, d)
        }
    }
    return due, rows.Err()
}

// MarkDelivery records`,
      ],
    ),
    'cmd/orchard-api/main.go': edits(
      ['    "' + MOD + '/internal/notify"\n', '    "' + MOD + '/internal/notify"\n    "' + MOD + '/internal/payments"\n'],
      ['    bookings := booking.NewService(db, mailer)\n', '    bookings := booking.NewService(db, mailer)\n    go payments.RetryLoop(ctx, db, log)\n'],
    ),
  }, { author: sam, at: at('2026-07-29 15:40') });

  const h3 = r.commit(h2, 'List deliveries that keep failing for staff', {
    'internal/httpapi/admin.go': `package httpapi

import "net/http"

// GET /admin/webhooks/dead-letters: deliveries that used up their retries.
func (h *handlers) deadLetters(w http.ResponseWriter, r *http.Request) {
    list, err := h.db.DeadLetters(r.Context())
    if err != nil {
        h.fail(w, r, err)
        return
    }
    writeJSON(w, http.StatusOK, map[string]any{"deliveries": list})
}
`,
    'internal/store/deliveries.go': (old: string) => replace('    "time"\n)', '    "time"\n\n    "github.com/jackc/pgx/v5"\n)')(old) + `
type DeadLetter struct {
    EventID   string \`json:"event_id"\`
    Kind      string \`json:"kind"\`
    Attempts  int    \`json:"attempts"\`
    LastError string \`json:"last_error"\`
}

// DeadLetters lists deliveries that are still unprocessed after their last allowed attempt.
func (db *DB) DeadLetters(ctx context.Context) ([]DeadLetter, error) {
    rows, err := db.pool.Query(ctx, \`
        SELECT event_id, kind, attempts, coalesce(last_error, '') FROM webhook_deliveries
        WHERE processed_at IS NULL AND attempts >= 8 ORDER BY received_at DESC\`)
    if err != nil {
        return nil, err
    }
    return pgx.CollectRows(rows, pgx.RowToStructByPos[DeadLetter])
}
`,
    'internal/httpapi/auth.go': append(`
// requireStaff answers 403 unless the member works at the studio.
func (h *handlers) requireStaff(next http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        if !memberFrom(r.Context()).IsStaff {
            writeError(w, http.StatusForbidden, "forbidden", "Only studio staff can do that.")
            return
        }
        next.ServeHTTP(w, r)
    })
}
`),
    'internal/httpapi/router.go': replace(
      '        r.Delete("/me/bookings/{id}", h.cancelBooking)\n    })\n',
      `        r.Delete("/me/bookings/{id}", h.cancelBooking)
    })

    r.Group(func(r chi.Router) {
        r.Use(h.authenticate, h.requireStaff)
        r.Get("/admin/webhooks/dead-letters", h.deadLetters)
    })
`,
    ),
  }, { author: sam, at: at('2026-07-30 09:55') });

  const a10 = r.commit(a9, 'Document the API error codes', {
    'README.md': append(`
## Errors

Every error is \`{"error": {"code": "...", "message": "..."}}\`. Clients switch on \`code\`; \`message\` is
for people and may change.

| code | status | when |
| --- | --- | --- |
| \`unauthenticated\` | 401 | no token, or an expired one |
| \`not_found\` | 404 | the class, booking or member doesn't exist (or isn't yours) |
| \`class_full\` | 409 | no spots left |
| \`already_booked\` | 409 | you already have a spot in this class |
| \`internal\` | 500 | our fault; it's logged |
`),
  }, { author: june, at: at('2026-08-03 10:20') });

  const merger = { author: sam, committer: sam };
  const m88 = r.commit(a10, `Merge pull request #88 from orchard-studio-demo/sam/webhook-deliveries\n\nRecord webhook deliveries before processing them`, {}, { ...merger, at: at('2026-08-04 14:12'), merge: h1, key: 'merge #88' });
  const m89 = r.commit(m88, `Merge pull request #89 from orchard-studio-demo/sam/webhook-retry\n\nRetry failed deliveries with exponential backoff`, {}, { ...merger, at: at('2026-08-05 09:31'), merge: h2, key: 'merge #89' });
  const m90 = r.commit(m89, `Merge pull request #90 from orchard-studio-demo/sam/webhook-dead-letters\n\nList deliveries that keep failing for staff`, {}, { ...merger, at: at('2026-08-06 16:47'), merge: h3, key: 'merge #90' });
  // a merge commit's tree is the merged result: take the PR's files over main's
  for (const [m, h] of [[m88, h1], [m89, h2], [m90, h3]] as const) mergeTrees(m, h, a9);

  const a14 = r.commit(m90, 'Bump Go to 1.23', {
    'go.mod': replace('go 1.22\n', 'go 1.23\n'),
    '.github/workflows/ci.yml': replace('go-version: "1.22"', 'go-version: "1.23"'),
  }, { author: june, at: at('2026-08-19 11:02') });

  const a15 = r.commit(a14, 'Log a request id on every request', {
    'internal/httpapi/middleware.go': `package httpapi

import (
    "context"
    "crypto/rand"
    "encoding/hex"
    "net/http"
    "time"
)

type requestIDKey struct{}

// requestID tags each request with an id (the caller's X-Request-Id, or a new one) and echoes it back.
func requestID(next http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        id := r.Header.Get("X-Request-Id")
        if id == "" || len(id) > 64 {
            b := make([]byte, 8)
            _, _ = rand.Read(b)
            id = hex.EncodeToString(b)
        }
        w.Header().Set("X-Request-Id", id)
        next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), requestIDKey{}, id)))
    })
}

type statusWriter struct {
    http.ResponseWriter
    status int
}

func (w *statusWriter) WriteHeader(code int) {
    w.status = code
    w.ResponseWriter.WriteHeader(code)
}

func (h *handlers) logRequests(next http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        start := time.Now()
        sw := &statusWriter{ResponseWriter: w, status: http.StatusOK}
        next.ServeHTTP(sw, r)
        id, _ := r.Context().Value(requestIDKey{}).(string)
        h.log.InfoContext(r.Context(), "request", "id", id, "method", r.Method, "path", r.URL.Path,
            "status", sw.status, "ms", time.Since(start).Milliseconds())
    })
}
`,
    'internal/httpapi/router.go': replace('    r := chi.NewRouter()\n', '    r := chi.NewRouter()\n    r.Use(requestID, h.logRequests)\n'),
  }, { author: theo, at: at('2026-08-27 15:26') });

  const a16 = r.commit(a15, 'Index bookings by member for My bookings', {
    'migrations/0004_bookings_member_index.sql': `-- "My bookings" filters by member; without this it scans every confirmed booking.
CREATE INDEX CONCURRENTLY bookings_member ON bookings (member_id) WHERE status = 'confirmed';
`,
  }, { author: june, at: at('2026-09-03 09:44') });

  // Theo's calendar feed (a small single-repo project), branched off a16
  const cal1 = r.commit(a16, 'Add an iCalendar encoder for bookings', {
    'internal/ical/ical.go': `// Package ical writes the small subset of RFC 5545 that calendar apps need for a booking.
package ical

import (
    "fmt"
    "io"
    "strings"
    "time"
)

type Event struct {
    UID      string
    Summary  string
    Location string
    Start    time.Time
    End      time.Time
}

// Write writes a VCALENDAR with one VEVENT per event. Lines are CRLF-terminated and folded at 75
// octets, as the RFC requires; Outlook rejects feeds that don't fold.
func Write(w io.Writer, name string, events []Event) error {
    var b strings.Builder
    line := func(s string) {
        for len(s) > 75 {
            b.WriteString(s[:75] + "\\r\\n ")
            s = s[75:]
        }
        b.WriteString(s + "\\r\\n")
    }
    line("BEGIN:VCALENDAR")
    line("VERSION:2.0")
    line("PRODID:-//Orchard//Bookings//EN")
    line("X-WR-CALNAME:" + escape(name))
    for _, e := range events {
        line("BEGIN:VEVENT")
        line("UID:" + e.UID)
        line("DTSTAMP:" + stamp(e.Start))
        line("DTSTART:" + stamp(e.Start))
        line("DTEND:" + stamp(e.End))
        line("SUMMARY:" + escape(e.Summary))
        if e.Location != "" {
            line("LOCATION:" + escape(e.Location))
        }
        line("END:VEVENT")
    }
    line("END:VCALENDAR")
    _, err := io.WriteString(w, b.String())
    return err
}

func stamp(t time.Time) string { return t.UTC().Format("20060102T150405Z") }

func escape(s string) string {
    return strings.NewReplacer("\\\\", "\\\\\\\\", ";", "\\\\;", ",", "\\\\,", "\\n", "\\\\n").Replace(s)
}

var _ = fmt.Sprintf
`,
    'internal/ical/ical_test.go': `package ical

import (
    "strings"
    "testing"
    "time"
)

func TestWriteFoldsLongLines(t *testing.T) {
    var b strings.Builder
    start := time.Date(2026, 9, 21, 7, 0, 0, 0, time.UTC)
    err := Write(&b, "My classes", []Event{{
        UID: "booking-1@orchard", Summary: strings.Repeat("Sunrise vinyasa, ", 8),
        Start: start, End: start.Add(time.Hour),
    }})
    if err != nil {
        t.Fatal(err)
    }
    for _, l := range strings.Split(b.String(), "\\r\\n") {
        if len(l) > 75 {
            t.Errorf("line longer than 75 octets: %q", l)
        }
    }
}
`,
  }, { author: theo, at: at('2026-09-09 10:05') });

  const cal2 = r.commit(cal1, 'Serve a private calendar feed per member\n\nGET /calendar/{token}.ics, unauthenticated by design (calendar apps can\'t send a bearer token),\nso the token is the secret: 32 random bytes, stored hashed.', {
    'migrations/0005_calendar_tokens.sql': `ALTER TABLE members ADD COLUMN calendar_token_hash bytea UNIQUE;
`,
    'internal/httpapi/calendar.go': `package httpapi

import (
    "crypto/sha256"
    "fmt"
    "net/http"
    "strings"
    "time"

    "github.com/go-chi/chi/v5"

    "${MOD}/internal/ical"
)

// GET /calendar/{token}.ics: the member's upcoming bookings as a calendar feed.
func (h *handlers) calendarFeed(w http.ResponseWriter, r *http.Request) {
    token := strings.TrimSuffix(chi.URLParam(r, "token"), ".ics")
    sum := sha256.Sum256([]byte(token))
    m, err := h.db.MemberByCalendarToken(r.Context(), sum[:])
    if err != nil {
        writeError(w, http.StatusNotFound, "not_found", "Not found.")
        return
    }
    list, err := h.db.MemberBookings(r.Context(), m.ID, time.Now().AddDate(0, 0, -7))
    if err != nil {
        h.fail(w, r, err)
        return
    }
    events := make([]ical.Event, 0, len(list))
    for _, b := range list {
        events = append(events, ical.Event{
            UID:     fmt.Sprintf("booking-%d@orchard", b.ID),
            Summary: b.Class.Title + " with " + b.Class.Coach,
            Start:   b.Class.StartsAt,
            End:     b.Class.StartsAt.Add(time.Duration(b.Class.Minutes) * time.Minute),
        })
    }
    w.Header().Set("Content-Type", "text/calendar; charset=utf-8")
    w.Header().Set("Cache-Control", "private, max-age=900")
    _ = ical.Write(w, "Orchard classes", events)
}
`,
    'internal/store/members.go': append(`
func (db *DB) MemberByCalendarToken(ctx context.Context, hash []byte) (Member, error) {
    var m Member
    err := db.pool.QueryRow(ctx, \`
        SELECT id, studio_id, name, email, is_staff FROM members WHERE calendar_token_hash = $1\`, hash,
    ).Scan(&m.ID, &m.StudioID, &m.Name, &m.Email, &m.IsStaff)
    return m, notFound(err)
}
`),
    'internal/httpapi/router.go': after('    r.Post("/webhooks/payments", h.paymentWebhook)\n', '    r.Get("/calendar/{token}", h.calendarFeed)\n'),
  }, { author: theo, at: at('2026-09-10 14:30') });

  const cal3 = r.commit(cal2, 'Rotate calendar tokens from account settings', {
    'internal/httpapi/calendar.go': edits(
      ['import (\n    "crypto/sha256"\n', 'import (\n    "crypto/rand"\n    "crypto/sha256"\n    "encoding/base64"\n'],
      [
        '// GET /calendar/{token}.ics',
        `// POST /me/calendar-token issues a new feed URL; the old one stops working at once.
func (h *handlers) rotateCalendarToken(w http.ResponseWriter, r *http.Request) {
    raw := make([]byte, 32)
    if _, err := rand.Read(raw); err != nil {
        h.fail(w, r, err)
        return
    }
    token := base64.RawURLEncoding.EncodeToString(raw)
    sum := sha256.Sum256([]byte(token))
    if err := h.db.SetCalendarToken(r.Context(), memberFrom(r.Context()).ID, sum[:]); err != nil {
        h.fail(w, r, err)
        return
    }
    writeJSON(w, http.StatusOK, map[string]string{"url": "/calendar/" + token + ".ics"})
}

// GET /calendar/{token}.ics`,
      ],
    ),
    'internal/store/members.go': append(`
func (db *DB) SetCalendarToken(ctx context.Context, memberID int64, hash []byte) error {
    _, err := db.pool.Exec(ctx, \`UPDATE members SET calendar_token_hash = $2 WHERE id = $1\`, memberID, hash)
    return err
}
`),
    'internal/httpapi/router.go': after('        r.Delete("/me/bookings/{id}", h.cancelBooking)\n', '        r.Post("/me/calendar-token", h.rotateCalendarToken)\n'),
  }, { author: theo, at: at('2026-09-11 09:12') });

  // Theo's follow-up, calendar reminders: a second project that builds on the calendar feed (project.yaml
  // `after:`), on its own branch on top of theo/calendar-feed
  const rem1 = r.commit(cal3, 'Add reminder alarms to calendar events\n\nA VALARM inside the VEVENT, triggered the given time before the start. Calendar apps\nshow it as their own notification, so nothing has to be sent from our side.', {
    'internal/ical/ical.go': edits(
      ['    End      time.Time\n}', '    End      time.Time\n    // Remind, if non-zero, adds an alarm this long before Start.\n    Remind   time.Duration\n}'],
      [
        '        line("END:VEVENT")',
        `        if e.Remind > 0 {
            line("BEGIN:VALARM")
            line("ACTION:DISPLAY")
            line("DESCRIPTION:" + escape(e.Summary))
            line(fmt.Sprintf("TRIGGER:-PT%dM", int(e.Remind/time.Minute)))
            line("END:VALARM")
        }
        line("END:VEVENT")`,
      ],
    ),
    'internal/ical/ical_test.go': append(`
func TestWriteAlarm(t *testing.T) {
    var b strings.Builder
    start := time.Date(2026, 9, 21, 7, 0, 0, 0, time.UTC)
    if err := Write(&b, "My classes", []Event{{UID: "booking-2@orchard", Summary: "Pilates", Start: start, End: start.Add(time.Hour), Remind: 90 * time.Minute}}); err != nil {
        t.Fatal(err)
    }
    if !strings.Contains(b.String(), "BEGIN:VALARM\\r\\nACTION:DISPLAY\\r\\nDESCRIPTION:Pilates\\r\\nTRIGGER:-PT90M\\r\\nEND:VALARM\\r\\n") {
        t.Errorf("no alarm, or the wrong one:\\n%s", b.String())
    }
}
`),
  }, { author: theo, at: at('2026-09-12 10:20') });

  const rem2 = r.commit(rem1, 'Remind members an hour before each class', {
    'internal/httpapi/calendar.go': replace(
      '            End:     b.Class.StartsAt.Add(time.Duration(b.Class.Minutes) * time.Minute),\n',
      '            End:     b.Class.StartsAt.Add(time.Duration(b.Class.Minutes) * time.Minute),\n            Remind:  time.Hour,\n',
    ),
  }, { author: theo, at: at('2026-09-12 11:05') });

  const rem3 = r.commit(rem2, 'Let members choose their reminder time\n\nPUT /me/calendar-reminder {"minutes": 30}; 0 turns reminders off. The feed reads it on every\nfetch, so a change shows up the next time the calendar app refreshes.', {
    'migrations/0006_calendar_reminders.sql': `ALTER TABLE members ADD COLUMN calendar_reminder_minutes integer NOT NULL DEFAULT 60
    CHECK (calendar_reminder_minutes BETWEEN 0 AND 1440);
`,
    'internal/httpapi/calendar.go': edits(
      ['    "encoding/base64"\n', '    "encoding/base64"\n    "encoding/json"\n'],
      [
        '    events := make([]ical.Event, 0, len(list))',
        `    remind, err := h.db.CalendarReminder(r.Context(), m.ID)
    if err != nil {
        h.fail(w, r, err)
        return
    }
    events := make([]ical.Event, 0, len(list))`,
      ],
      ['            Remind:  time.Hour,\n', '            Remind:  remind,\n'],
      [
        '// GET /calendar/{token}.ics: the member',
        `// PUT /me/calendar-reminder {"minutes": 60}: how long before each class the feed reminds the
// member; 0 turns reminders off.
func (h *handlers) setCalendarReminder(w http.ResponseWriter, r *http.Request) {
    var body struct {
        Minutes int \`json:"minutes"\`
    }
    if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.Minutes < 0 || body.Minutes > 24*60 {
        writeError(w, http.StatusBadRequest, "bad_request", "minutes must be between 0 and 1440.")
        return
    }
    if err := h.db.SetCalendarReminder(r.Context(), memberFrom(r.Context()).ID, body.Minutes); err != nil {
        h.fail(w, r, err)
        return
    }
    w.WriteHeader(http.StatusNoContent)
}

// GET /calendar/{token}.ics: the member`,
      ],
    ),
    'internal/store/members.go': append(`
// CalendarReminder is how long before a class the member's calendar feed reminds them (0: never).
func (db *DB) CalendarReminder(ctx context.Context, memberID int64) (time.Duration, error) {
    var minutes int
    err := db.pool.QueryRow(ctx, \`SELECT calendar_reminder_minutes FROM members WHERE id = $1\`, memberID).Scan(&minutes)
    return time.Duration(minutes) * time.Minute, notFound(err)
}

func (db *DB) SetCalendarReminder(ctx context.Context, memberID int64, minutes int) error {
    _, err := db.pool.Exec(ctx, \`UPDATE members SET calendar_reminder_minutes = $2 WHERE id = $1\`, memberID, minutes)
    return err
}
`),
    'internal/httpapi/router.go': after('        r.Post("/me/calendar-token", h.rotateCalendarToken)\n', '        r.Put("/me/calendar-reminder", h.setCalendarReminder)\n'),
  }, { author: theo, at: at('2026-09-13 16:40') });

  // ---------------------------------------------------------------- Maya's waitlists branch (off a16)
  const f1 = r.commit(a16, 'Add the waitlist_entries table\n\nOne row per member per class. Position is set when they join; status tracks the offer\nlifecycle (waiting, offered, accepted, left, expired). Nothing reads or writes it yet.', {
    'migrations/0005_waitlist.sql': `CREATE TYPE waitlist_status AS ENUM ('waiting', 'offered', 'accepted', 'left', 'expired');

CREATE TABLE waitlist_entries (
    id          bigserial PRIMARY KEY,
    class_id    bigint NOT NULL REFERENCES classes (id) ON DELETE CASCADE,
    member_id   bigint NOT NULL REFERENCES members (id),
    position    integer NOT NULL,
    status      waitlist_status NOT NULL DEFAULT 'waiting',
    hold_until  timestamptz,
    created_at  timestamptz NOT NULL DEFAULT now(),
    UNIQUE (class_id, member_id)
);

-- the next person in line for a class
CREATE INDEX waitlist_entries_next ON waitlist_entries (class_id, position) WHERE status = 'waiting';
-- offers whose hold has run out (the expiry sweep)
CREATE INDEX waitlist_entries_hold ON waitlist_entries (hold_until) WHERE status = 'offered';
`,
  }, { author: maya, at: at('2026-09-08 10:14'), key: 'f1' });

  const f2 = r.commit(f1, 'Add a waitlist store', {
    'internal/store/waitlist.go': `package store

import (
    "context"
    "time"

    "github.com/jackc/pgx/v5"
)

type WaitlistStatus string

const (
    WaitlistWaiting  WaitlistStatus = "waiting"
    WaitlistOffered  WaitlistStatus = "offered"  // a spot opened up; it's held for them until HoldUntil
    WaitlistAccepted WaitlistStatus = "accepted" // they took the spot: there's a booking now
    WaitlistLeft     WaitlistStatus = "left"
    WaitlistExpired  WaitlistStatus = "expired" // the hold ran out before they accepted
)

type WaitlistEntry struct {
    ID        int64
    ClassID   int64
    MemberID  int64
    Position  int
    Status    WaitlistStatus
    HoldUntil *time.Time
    CreatedAt time.Time
}

const waitlistColumns = \`id, class_id, member_id, position, status, hold_until, created_at\`

func scanWaitlistEntry(row pgx.Row) (WaitlistEntry, error) {
    var e WaitlistEntry
    err := row.Scan(&e.ID, &e.ClassID, &e.MemberID, &e.Position, &e.Status, &e.HoldUntil, &e.CreatedAt)
    return e, notFound(err)
}

// JoinWaitlist puts a member at the back of a class's line. Someone who left (or whose offer
// expired) and joins again goes to the back, not to their old place.
func JoinWaitlist(ctx context.Context, tx pgx.Tx, classID, memberID int64) (WaitlistEntry, error) {
    return scanWaitlistEntry(tx.QueryRow(ctx, \`
        INSERT INTO waitlist_entries (class_id, member_id, position)
        VALUES ($1, $2, (SELECT coalesce(max(position), 0) + 1 FROM waitlist_entries WHERE class_id = $1))
        ON CONFLICT (class_id, member_id) DO UPDATE
            SET position = EXCLUDED.position, status = 'waiting', hold_until = NULL, created_at = now()
        RETURNING \`+waitlistColumns, classID, memberID))
}

// LeaveWaitlist takes a member out of a class's line (or gives back a spot they were offered).
func LeaveWaitlist(ctx context.Context, tx pgx.Tx, classID, memberID int64) error {
    _, err := tx.Exec(ctx, \`
        UPDATE waitlist_entries SET status = 'left'
        WHERE class_id = $1 AND member_id = $2 AND status IN ('waiting', 'offered')\`, classID, memberID)
    return err
}

// FirstWaiting is the member at the front of a class's line, or ErrNotFound if nobody is waiting.
func FirstWaiting(ctx context.Context, tx pgx.Tx, classID int64) (WaitlistEntry, error) {
    return scanWaitlistEntry(tx.QueryRow(ctx, \`
        SELECT \`+waitlistColumns+\` FROM waitlist_entries
        WHERE class_id = $1 AND status = 'waiting'
        ORDER BY position
        LIMIT 1\`, classID))
}
`,
    'internal/store/waitlist_test.go': `package store_test

import (
    "context"
    "testing"

    "github.com/jackc/pgx/v5"

    "${MOD}/internal/store"
    "${MOD}/internal/store/storetest"
)

func TestRejoiningGoesToTheBack(t *testing.T) {
    ctx := context.Background()
    db := storetest.New(t)
    class := storetest.Class(t, db, 1)
    a, b := storetest.Member(t, db), storetest.Member(t, db)

    err := db.Tx(ctx, func(tx pgx.Tx) error {
        for _, m := range []store.Member{a, b} {
            if _, err := store.JoinWaitlist(ctx, tx, class.ID, m.ID); err != nil {
                return err
            }
        }
        if err := store.LeaveWaitlist(ctx, tx, class.ID, a.ID); err != nil {
            return err
        }
        again, err := store.JoinWaitlist(ctx, tx, class.ID, a.ID)
        if err != nil {
            return err
        }
        if again.Position != 3 {
            t.Errorf("rejoined at position %d, want 3 (the back)", again.Position)
        }
        first, err := store.FirstWaiting(ctx, tx, class.ID)
        if err != nil {
            return err
        }
        if first.MemberID != b.ID {
            t.Errorf("first in line is member %d, want %d", first.MemberID, b.ID)
        }
        return nil
    })
    if err != nil {
        t.Fatal(err)
    }
}
`,
  }, { author: maya, at: at('2026-09-08 15:37'), key: 'f2' });

  const f3 = r.commit(f2, "Let members join a full class's waitlist", {
    'internal/booking/waitlist.go': `package booking

import (
    "context"
    "errors"

    "github.com/jackc/pgx/v5"

    "${MOD}/internal/store"
)

// ErrClassNotFull is returned when someone tries to join the waitlist of a class they could just book.
var ErrClassNotFull = errors.New("class has free spots")

// JoinWaitlist puts a member at the back of a full class's waitlist.
func (s *Service) JoinWaitlist(ctx context.Context, classID, memberID int64) (store.WaitlistEntry, error) {
    var e store.WaitlistEntry
    err := s.db.Tx(ctx, func(tx pgx.Tx) error {
        class, err := store.LockClass(ctx, tx, classID)
        if err != nil {
            return err
        }
        booked, err := store.HasBooking(ctx, tx, classID, memberID)
        if err != nil {
            return err
        }
        if booked {
            return ErrAlreadyBooked
        }
        n, err := store.CountBookings(ctx, tx, classID)
        if err != nil {
            return err
        }
        if n < class.Capacity {
            return ErrClassNotFull
        }
        e, err = store.JoinWaitlist(ctx, tx, classID, memberID)
        return err
    })
    return e, err
}
`,
    'internal/httpapi/waitlist.go': `package httpapi

import (
    "errors"
    "net/http"
    "time"

    "${MOD}/internal/booking"
    "${MOD}/internal/store"
)

type waitlistJSON struct {
    ID        int64      \`json:"id"\`
    ClassID   int64      \`json:"class_id"\`
    Position  int        \`json:"position"\`
    Status    string     \`json:"status"\`
    HoldUntil *time.Time \`json:"hold_until,omitempty"\`
}

func toWaitlistJSON(e store.WaitlistEntry) waitlistJSON {
    return waitlistJSON{ID: e.ID, ClassID: e.ClassID, Position: e.Position, Status: string(e.Status), HoldUntil: e.HoldUntil}
}

// POST /classes/{id}/waitlist joins the waitlist of a full class.
func (h *handlers) joinWaitlist(w http.ResponseWriter, r *http.Request) {
    classID, ok := pathID(w, r, "id")
    if !ok {
        return
    }
    e, err := h.bookings.JoinWaitlist(r.Context(), classID, memberFrom(r.Context()).ID)
    switch {
    case errors.Is(err, store.ErrNotFound):
        writeError(w, http.StatusNotFound, "not_found", "No such class.")
    case errors.Is(err, booking.ErrClassNotFull):
        writeError(w, http.StatusConflict, "class_not_full", "This class has space: book it instead.")
    case errors.Is(err, booking.ErrAlreadyBooked):
        writeError(w, http.StatusConflict, "already_booked", "You already have a spot in this class.")
    case err != nil:
        h.fail(w, r, err)
    default:
        writeJSON(w, http.StatusCreated, toWaitlistJSON(e))
    }
}
`,
    'internal/httpapi/router.go': after('        r.Post("/classes/{id}/bookings", h.book)\n', '        r.Post("/classes/{id}/waitlist", h.joinWaitlist)\n'),
    'README.md': replace('| `already_booked` | 409 | you already have a spot in this class |\n', '| `already_booked` | 409 | you already have a spot in this class |\n| `class_not_full` | 409 | joining the waitlist of a class you could book |\n'),
  }, { author: maya, at: at('2026-09-09 11:20'), key: 'f3' });

  const f4 = r.commit(f3, 'Let members leave a waitlist', {
    'internal/booking/waitlist.go': append(`
// LeaveWaitlist takes a member off a class's waitlist. Leaving a waitlist you're not on isn't an error:
// the app retries on flaky connections.
func (s *Service) LeaveWaitlist(ctx context.Context, classID, memberID int64) error {
    return s.db.Tx(ctx, func(tx pgx.Tx) error {
        return store.LeaveWaitlist(ctx, tx, classID, memberID)
    })
}
`),
    'internal/httpapi/waitlist.go': append(`
// DELETE /classes/{id}/waitlist
func (h *handlers) leaveWaitlist(w http.ResponseWriter, r *http.Request) {
    classID, ok := pathID(w, r, "id")
    if !ok {
        return
    }
    if err := h.bookings.LeaveWaitlist(r.Context(), classID, memberFrom(r.Context()).ID); err != nil {
        h.fail(w, r, err)
        return
    }
    w.WriteHeader(http.StatusNoContent)
}
`),
    'internal/httpapi/router.go': after('        r.Post("/classes/{id}/waitlist", h.joinWaitlist)\n', '        r.Delete("/classes/{id}/waitlist", h.leaveWaitlist)\n'),
  }, { author: maya, at: at('2026-09-09 16:02'), key: 'f4' });

  const f5 = r.commit(f4, 'Show waitlist position in the bookings API', {
    'internal/store/waitlist.go': append(`
// MemberWaitlistEntry is one of a member's waitlist places, with its class and live position.
type MemberWaitlistEntry struct {
    WaitlistEntry
    Class Class
}

// MemberWaitlist lists the waitlists a member is on (waiting or offered a spot) for classes that
// haven't started. Position counts only the people still waiting ahead of them.
func (db *DB) MemberWaitlist(ctx context.Context, memberID int64, since time.Time) ([]MemberWaitlistEntry, error) {
    rows, err := db.pool.Query(ctx, \`
        SELECT w.id, w.class_id, w.member_id,
               (SELECT count(*) FROM waitlist_entries a
                WHERE a.class_id = w.class_id AND a.status = 'waiting' AND a.position <= w.position),
               w.status, w.hold_until, w.created_at, \`+classColumns+\`
        FROM waitlist_entries w JOIN classes c ON c.id = w.class_id
        WHERE w.member_id = $1 AND w.status IN ('waiting', 'offered') AND c.starts_at >= $2
        ORDER BY c.starts_at\`, memberID, since)
    if err != nil {
        return nil, err
    }
    return pgx.CollectRows(rows, func(row pgx.CollectableRow) (MemberWaitlistEntry, error) {
        var e MemberWaitlistEntry
        c := &e.Class
        err := row.Scan(&e.ID, &e.ClassID, &e.MemberID, &e.Position, &e.Status, &e.HoldUntil, &e.CreatedAt,
            &c.ID, &c.StudioID, &c.Title, &c.Coach, &c.StartsAt, &c.Minutes, &c.Capacity, &c.Booked)
        return e, err
    })
}
`),
    'internal/httpapi/bookings.go': edits(
      [
        '    out := make([]bookingJSON, 0, len(list))\n',
        `    waiting, err := h.db.MemberWaitlist(r.Context(), memberFrom(r.Context()).ID, time.Now())
    if err != nil {
        h.fail(w, r, err)
        return
    }
    out := make([]bookingJSON, 0, len(list))
`,
      ],
      [
        '    writeJSON(w, http.StatusOK, map[string]any{"bookings": out})',
        `    wl := make([]waitlistJSON, 0, len(waiting))
    for _, e := range waiting {
        j := toWaitlistJSON(e.WaitlistEntry)
        c := toClassJSON(e.Class)
        j.Class = &c
        wl = append(wl, j)
    }
    writeJSON(w, http.StatusOK, map[string]any{"bookings": out, "waitlist": wl})`,
      ],
    ),
    'internal/httpapi/waitlist.go': replace(
      '    HoldUntil *time.Time `json:"hold_until,omitempty"`\n}',
      '    HoldUntil *time.Time `json:"hold_until,omitempty"`\n    Class     *classJSON `json:"class,omitempty"`\n}',
    ),
  }, { author: maya, at: at('2026-09-10 09:48'), key: 'f5' });

  // "Promote the first waitlisted member when a spot opens", as first written (v1) and after review (v2)
  const f6 = r.commit(f5, 'Promote the first waitlisted member when a spot opens\n\nCancelling a booking offers the freed spot to the first member in the waitlist, who has\nHoldWindow to accept it.', promoteChanges('v1'), { author: maya, at: at('2026-09-10 14:55'), key: 'f6' });

  const f7 = r.commit(f6, 'Expire unconfirmed promotions after the hold window', expiryChanges('v1'), { author: maya, at: at('2026-09-11 10:30'), key: 'f7' });

  const f8 = r.commit(f7, 'Send promotion notifications', {
    'migrations/0006_notification_outbox.sql': `-- Messages are queued in the same transaction as the change they announce, and sent by
-- notify.Relay after it commits: an offer that rolls back never emails anyone.
CREATE TABLE notification_outbox (
    id          bigserial PRIMARY KEY,
    member_id   bigint NOT NULL REFERENCES members (id),
    subject     text NOT NULL,
    body        text NOT NULL,
    created_at  timestamptz NOT NULL DEFAULT now(),
    sent_at     timestamptz
);

CREATE INDEX notification_outbox_unsent ON notification_outbox (id) WHERE sent_at IS NULL;
`,
    'internal/store/outbox.go': `package store

import (
    "context"

    "github.com/jackc/pgx/v5"
)

// EnqueueNotification queues a message in the caller's transaction.
func EnqueueNotification(ctx context.Context, tx pgx.Tx, memberID int64, subject, body string) error {
    _, err := tx.Exec(ctx, \`INSERT INTO notification_outbox (member_id, subject, body) VALUES ($1, $2, $3)\`, memberID, subject, body)
    return err
}

type Outgoing struct {
    ID       int64
    MemberID int64
    Subject  string
    Body     string
}

// ClaimNotifications locks up to limit unsent messages for this transaction. SKIP LOCKED lets every
// API replica run a relay: each one takes different rows, and a message is sent once.
func ClaimNotifications(ctx context.Context, tx pgx.Tx, limit int) ([]Outgoing, error) {
    rows, err := tx.Query(ctx, \`
        SELECT id, member_id, subject, body FROM notification_outbox
        WHERE sent_at IS NULL ORDER BY id LIMIT $1
        FOR UPDATE SKIP LOCKED\`, limit)
    if err != nil {
        return nil, err
    }
    return pgx.CollectRows(rows, pgx.RowToStructByPos[Outgoing])
}

func MarkSent(ctx context.Context, tx pgx.Tx, id int64) error {
    _, err := tx.Exec(ctx, \`UPDATE notification_outbox SET sent_at = now() WHERE id = $1\`, id)
    return err
}
`,
    'internal/notify/relay.go': `package notify

import (
    "context"
    "log/slog"
    "time"

    "github.com/jackc/pgx/v5"

    "${MOD}/internal/store"
)

// Relay sends queued messages until ctx ends.
func Relay(ctx context.Context, db *store.DB, n Notifier, log *slog.Logger) {
    tick := time.NewTicker(2 * time.Second)
    defer tick.Stop()
    for {
        select {
        case <-ctx.Done():
            return
        case <-tick.C:
        }
        err := db.Tx(ctx, func(tx pgx.Tx) error {
            batch, err := store.ClaimNotifications(ctx, tx, 50)
            if err != nil {
                return err
            }
            for _, m := range batch {
                if err := n.Notify(ctx, Message{MemberID: m.MemberID, Subject: m.Subject, Body: m.Body}); err != nil {
                    log.Warn("notify", "outbox", m.ID, "err", err)
                    continue // stays unsent; retried on the next tick
                }
                if err := store.MarkSent(ctx, tx, m.ID); err != nil {
                    return err
                }
            }
            return nil
        })
        if err != nil {
            log.Error("relay notifications", "err", err)
        }
    }
}
`,
    'internal/notify/messages.go': `package notify

import (
    "fmt"
    "time"

    "${MOD}/internal/store"
)

// SpotOffered tells a member a spot opened up in a class they were waiting for.
func SpotOffered(memberID int64, class store.Class, holdUntil time.Time) Message {
    return Message{
        MemberID: memberID,
        Subject:  "A spot opened up in " + class.Title,
        Body: fmt.Sprintf("Good news: a spot in %s with %s (%s) is yours if you want it.\\n\\n"+
            "We're holding it for you until %s. Open the app to take it; after that it goes to the next person in line.",
            class.Title, class.Coach, class.StartsAt.Format("Mon 2 Jan, 15:04"), holdUntil.Format("15:04")),
    }
}
`,
    'internal/booking/promote.go': edits(
      ['    "' + MOD + '/internal/store"\n', '    "' + MOD + '/internal/notify"\n    "' + MOD + '/internal/store"\n'],
      [
        '    if err := store.OfferSpot(ctx, tx, entry.ID, holdUntil); err != nil {\n        return nil, err\n    }\n',
        `    if err := store.OfferSpot(ctx, tx, entry.ID, holdUntil); err != nil {
        return nil, err
    }
    // queued in this transaction, so the email only goes out if the offer commits
    msg := notify.SpotOffered(entry.MemberID, class, holdUntil)
    if err := store.EnqueueNotification(ctx, tx, msg.MemberID, msg.Subject, msg.Body); err != nil {
        return nil, err
    }
`,
      ],
    ),
    'cmd/orchard-api/main.go': replace('    go payments.RetryLoop(ctx, db, log)\n', '    go payments.RetryLoop(ctx, db, log)\n    go notify.Relay(ctx, db, mailer, log)\n'),
  }, { author: maya, at: at('2026-09-11 15:12'), key: 'f8' });

  const f9 = r.commit(f8, 'Let studio staff reorder a waitlist', {
    'internal/store/waitlist.go': append(`
// MoveInWaitlist puts a waiting entry at a new position, shifting the people between.
func MoveInWaitlist(ctx context.Context, tx pgx.Tx, classID, entryID int64, to int) error {
    _, err := tx.Exec(ctx, \`
        WITH moving AS (SELECT position AS from_pos FROM waitlist_entries WHERE id = $2 AND class_id = $1)
        UPDATE waitlist_entries w SET position = CASE
            WHEN w.id = $2 THEN $3
            WHEN m.from_pos < $3 AND w.position > m.from_pos AND w.position <= $3 THEN w.position - 1
            WHEN m.from_pos > $3 AND w.position >= $3 AND w.position < m.from_pos THEN w.position + 1
            ELSE w.position END
        FROM moving m
        WHERE w.class_id = $1\`, classID, entryID, to)
    return err
}
`),
    'internal/httpapi/admin.go': edits(
      ['import "net/http"', 'import (\n    "encoding/json"\n    "net/http"\n\n    "github.com/jackc/pgx/v5"\n\n    "' + MOD + '/internal/store"\n)'],
    ),
    'internal/httpapi/waitlist_admin.go': `package httpapi

import (
    "context"
    "encoding/json"
    "net/http"

    "github.com/jackc/pgx/v5"

    "${MOD}/internal/store"
)

// PUT /admin/classes/{id}/waitlist/{entry}/position {"position": 1}: staff move someone up or down
// the line, e.g. a regular who was double-booked by mistake.
func (h *handlers) moveInWaitlist(w http.ResponseWriter, r *http.Request) {
    classID, ok := pathID(w, r, "id")
    if !ok {
        return
    }
    entryID, ok := pathID(w, r, "entry")
    if !ok {
        return
    }
    var req struct {
        Position int \`json:"position"\`
    }
    if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.Position < 1 {
        writeError(w, http.StatusBadRequest, "bad_request", "position must be a number from 1.")
        return
    }
    err := h.db.Tx(r.Context(), func(tx pgx.Tx) error {
        if _, err := store.LockClass(context.WithoutCancel(r.Context()), tx, classID); err != nil {
            return err
        }
        return store.MoveInWaitlist(r.Context(), tx, classID, entryID, req.Position)
    })
    if err != nil {
        h.fail(w, r, err)
        return
    }
    w.WriteHeader(http.StatusNoContent)
}
`,
    'internal/httpapi/router.go': after('        r.Get("/admin/webhooks/dead-letters", h.deadLetters)\n', '        r.Put("/admin/classes/{id}/waitlist/{entry}/position", h.moveInWaitlist)\n'),
  }, { author: maya, at: at('2026-09-12 11:41'), key: 'f9' });

  const f10 = r.commit(f9, 'Add a per-class waitlist cap', {
    'migrations/0007_waitlist_cap.sql': `-- NULL: no cap. Studios asked for this for small classes, where a line of 30 is just noise.
ALTER TABLE classes ADD COLUMN waitlist_cap integer CHECK (waitlist_cap > 0);
`,
    'internal/booking/waitlist.go': edits(
      ['var ErrClassNotFull = errors.New("class has free spots")', 'var ErrClassNotFull = errors.New("class has free spots")\n\n// ErrWaitlistFull is returned when a class\'s waitlist is at its cap.\nvar ErrWaitlistFull = errors.New("waitlist is full")'],
      [
        '        e, err = store.JoinWaitlist(ctx, tx, classID, memberID)',
        `        if class.WaitlistCap > 0 {
            waiting, err := store.CountWaiting(ctx, tx, classID)
            if err != nil {
                return err
            }
            if waiting >= class.WaitlistCap {
                return ErrWaitlistFull
            }
        }
        e, err = store.JoinWaitlist(ctx, tx, classID, memberID)`,
      ],
    ),
    'internal/store/waitlist.go': append(`
func CountWaiting(ctx context.Context, tx pgx.Tx, classID int64) (int, error) {
    var n int
    err := tx.QueryRow(ctx, \`SELECT count(*) FROM waitlist_entries WHERE class_id = $1 AND status = 'waiting'\`, classID).Scan(&n)
    return n, err
}
`),
    'internal/store/classes.go': replace('    Booked   int // confirmed bookings\n', '    Booked   int // confirmed bookings\n\n    WaitlistCap int // 0: no cap\n'),
  }, { author: maya, at: at('2026-09-12 16:20'), key: 'f10' });

  // main moves on while the stack is in review
  const a17 = r.commit(a16, 'Refuse bookings for classes that have already started', {
    'internal/booking/service.go': edits(
      ['    ErrAlreadyBooked = errors.New("already booked")\n', '    ErrAlreadyBooked = errors.New("already booked")\n    ErrClassStarted  = errors.New("class has started")\n'],
      ['        booked, err := store.HasBooking(ctx, tx, classID, memberID)\n', '        if !class.StartsAt.After(s.now()) {\n            return ErrClassStarted\n        }\n        booked, err := store.HasBooking(ctx, tx, classID, memberID)\n'],
    ),
    'internal/httpapi/bookings.go': replace(
      '    case errors.Is(err, booking.ErrClassFull):\n',
      '    case errors.Is(err, booking.ErrClassStarted):\n        writeError(w, http.StatusConflict, "class_started", "This class has already started.")\n    case errors.Is(err, booking.ErrClassFull):\n',
    ),
  }, { author: theo, at: at('2026-09-11 13:35') });

  // Groundwork (#112, #113) goes up and is squash-merged; GitHub rebases #113 onto main after #112 lands
  const s112 = r.commit(a17, 'Add the waitlist_entries table (#112)', f1.changes, { author: maya, at: at('2026-09-14 10:02'), key: 'squash #112' });
  const [f2gh] = r.replay([f2], s112, { at: at('2026-09-14 10:02'), tag: 'reviewed' });
  r.rekey(f2gh, 'f2 on GitHub');
  r.rekey(r.get('f2@reviewed'), 'f2');
  const s113 = r.commit(s112, 'Add a waitlist store (#113)', f2.changes, { author: maya, at: at('2026-09-14 10:09'), key: 'squash #113' });

  // Maya freezes the landed PRs, then rebases the rest of the stack onto the new main (with --update-refs)
  r.replay([f3, f4, f5, f6, f7, f8, f9, f10], s113, { at: at('2026-09-15 08:40'), tag: 'before rebase' });

  // review of "Promote…": the fix is squashed into it (and the call site in "Expire…" adapted); the stack rebased
  // again. The branch tag on "Expire…" wasn't moved (no --update-refs that time): it shows as `moved`.
  const f6v1 = r.get('f6');
  r.rekey(f6v1, 'f6@v1');
  const f6v2 = r.commit(f6v1.parent, f6v1.message, promoteChanges('v2'), { author: maya, at: f6v1.authorAt, committedAt: at('2026-09-16 15:18'), key: 'f6' });
  r.replay(['f7', 'f8', 'f9', 'f10'].map((k) => r.get(k)), f6v2, { at: at('2026-09-16 15:18'), tag: 'v1', override: { f7: expiryChanges('v2') } });

  // ---------------------------------------------------------------- refs
  r.ref('main', a17);
  r.ref('refs/remotes/origin/main', s113);
  r.ref('refs/remotes/origin/HEAD', s113);
  r.ref('maya/waitlists', r.get('f10'));
  // branch tags, one per PR (AGENTS.md "Branch tagging"); the merged ones were deleted on GitHub but are kept locally
  r.ref('maya/waitlist-table', f1);
  r.ref('maya/waitlist-store', r.get('f2'));
  r.ref('maya/waitlist-join', r.get('f3'));
  r.ref('maya/waitlist-leave', r.get('f4'));
  r.ref('maya/waitlist-position', r.get('f5'));
  r.ref('maya/promote-on-cancel', r.get('f6'));
  r.ref('maya/promotion-expiry', r.get('f7@v1')); // left behind by the second rebase: `moved`
  r.ref('maya/promotion-emails', r.get('f8'));
  r.ref('refs/remotes/origin/maya/waitlist-join', r.get('f3'));
  r.ref('refs/remotes/origin/maya/waitlist-leave', r.get('f4'));
  r.ref('refs/remotes/origin/maya/waitlist-position', r.get('f5'));
  r.ref('refs/pull/112/head', f1);
  r.ref('refs/pull/113/head', f2gh);
  // Sam's merged stack: the PR heads, as fetched from GitHub's pull refs
  r.ref('refs/pull/88/head', h1);
  r.ref('refs/pull/89/head', h2);
  r.ref('refs/pull/90/head', h3);
  // Theo's calendar feed
  r.ref('theo/calendar-feed', cal3);
  r.ref('refs/remotes/origin/theo/calendar-feed', cal3);
  // Theo's calendar reminders (builds on the calendar feed), one branch tag per PR
  r.ref('theo/calendar-reminders', rem3);
  r.ref('theo/calendar-alarms', rem1);
  r.ref('theo/calendar-remind-hour', rem2);
  return r;
}

/** A merge commit's tree: main's files plus whatever the merged branch changed since `base`. */
function mergeTrees(merge: Commit, branch: Commit, base: Commit) {
  for (const [p, c] of branch.files) if (base.files.get(p) !== c) merge.files.set(p, c);
  for (const p of base.files.keys()) if (!branch.files.has(p)) merge.files.delete(p);
}

/** "Promote the first waitlisted member when a spot opens": v1 as first reviewed; v2 after the review. */
function promoteChanges(v: 'v1' | 'v2'): Changes {
  const head =
    v === 'v1'
      ? `// promoteFirstWaiting offers a freed spot in a class to the first member in its line, and holds
// it for them for HoldWindow. It returns the entry it promoted, or nil if the class is still full
// or nobody is waiting.
func (s *Service) promoteFirstWaiting(ctx context.Context, tx pgx.Tx, classID int64) (*store.WaitlistEntry, error) {
    class, err := s.db.Class(ctx, classID)
    if err != nil {
        return nil, err
    }
    n, err := store.CountBookings(ctx, tx, classID)
    if err != nil {
        return nil, err
    }
    if n >= class.Capacity {
        return nil, nil
    }
    entry, err := store.FirstWaiting(ctx, tx, classID)`
      : `// promoteFirstWaiting offers a freed spot in a class to the first member in its line, and holds
// it for them for HoldWindow. It runs in the caller's transaction, which must hold the class lock
// (store.LockClass). It returns the entry it promoted, or nil if the class is still full or nobody
// is waiting.
func (s *Service) promoteFirstWaiting(ctx context.Context, tx pgx.Tx, class store.Class) (*store.WaitlistEntry, error) {
    n, err := store.CountBookings(ctx, tx, class.ID)
    if err != nil {
        return nil, err
    }
    if n >= class.Capacity {
        return nil, nil
    }
    entry, err := store.FirstWaiting(ctx, tx, class.ID)`;
  const cancel =
    v === 'v1'
      ? `        b, err := store.CancelBooking(ctx, tx, bookingID, memberID)
        if err != nil {
            return err
        }
        _, err = s.promoteFirstWaiting(ctx, tx, b.ClassID)
        return err`
      : `        b, err := store.CancelBooking(ctx, tx, bookingID, memberID)
        if err != nil {
            return err
        }
        // lock the class first: two cancellations at once must not both see the same free spot
        class, err := store.LockClass(ctx, tx, b.ClassID)
        if err != nil {
            return err
        }
        _, err = s.promoteFirstWaiting(ctx, tx, class)
        return err`;
  const concurrencyTest =
    v === 'v1'
      ? ''
      : `
func TestConcurrentCancellationsOfferOneSpotEach(t *testing.T) {
    db := storetest.New(t)
    svc := booking.NewService(db, notify.Discard)
    class := storetest.Class(t, db, 2)
    var bookings []store.Booking
    for range 2 {
        b, err := svc.Book(ctx, class.ID, storetest.Member(t, db).ID)
        if err != nil {
            t.Fatal(err)
        }
        bookings = append(bookings, b)
    }
    waiting := []store.Member{storetest.Member(t, db), storetest.Member(t, db), storetest.Member(t, db)}
    for _, m := range waiting {
        if _, err := svc.JoinWaitlist(ctx, class.ID, m.ID); err != nil {
            t.Fatal(err)
        }
    }

    var wg sync.WaitGroup
    for _, b := range bookings {
        wg.Add(1)
        go func() {
            defer wg.Done()
            if err := svc.Cancel(ctx, b.ID, b.MemberID); err != nil {
                t.Error(err)
            }
        }()
    }
    wg.Wait()

    // two spots freed: the first two in line get one each, the third keeps waiting
    want := []store.WaitlistStatus{store.WaitlistOffered, store.WaitlistOffered, store.WaitlistWaiting}
    for i, m := range waiting {
        if got := storetest.WaitlistStatus(t, db, class.ID, m.ID); got != want[i] {
            t.Errorf("member %d in line: %s, want %s", i+1, got, want[i])
        }
    }
}
`;
  return {
    'internal/booking/promote.go': `package booking

import (
    "context"
    "errors"
    "time"

    "github.com/jackc/pgx/v5"

    "${MOD}/internal/store"
)

// HoldWindow is how long a member has to accept a spot offered to them from the waitlist.
const HoldWindow = 2 * time.Hour

// ErrOfferGone is returned when a member accepts an offer that expired or was withdrawn.
var ErrOfferGone = errors.New("offer is no longer open")

${head}
    if errors.Is(err, store.ErrNotFound) {
        return nil, nil
    }
    if err != nil {
        return nil, err
    }
    holdUntil := s.now().Add(HoldWindow)
    if err := store.OfferSpot(ctx, tx, entry.ID, holdUntil); err != nil {
        return nil, err
    }
    entry.Status, entry.HoldUntil = store.WaitlistOffered, &holdUntil
    return &entry, nil
}

// AcceptOffer turns a member's open offer into a booking.
func (s *Service) AcceptOffer(ctx context.Context, entryID, memberID int64) (store.Booking, error) {
    var b store.Booking
    err := s.db.Tx(ctx, func(tx pgx.Tx) error {
        e, err := store.TakeOffer(ctx, tx, entryID, memberID, s.now())
        if errors.Is(err, store.ErrNotFound) {
            return ErrOfferGone
        }
        if err != nil {
            return err
        }
        b, err = store.CreateBooking(ctx, tx, e.ClassID, memberID)
        return err
    })
    return b, err
}
`,
    'internal/booking/promote_test.go': `package booking_test

import (
    "testing"${v === 'v2' ? '\n    "sync"' : ''}

    "${MOD}/internal/booking"
    "${MOD}/internal/notify"
    "${MOD}/internal/store"
    "${MOD}/internal/store/storetest"
)

func TestCancelOffersTheSpotToTheFirstInLine(t *testing.T) {
    db := storetest.New(t)
    svc := booking.NewService(db, notify.Discard)
    class := storetest.Class(t, db, 1)
    booker, first, second := storetest.Member(t, db), storetest.Member(t, db), storetest.Member(t, db)

    b, err := svc.Book(ctx, class.ID, booker.ID)
    if err != nil {
        t.Fatal(err)
    }
    for _, m := range []store.Member{first, second} {
        if _, err := svc.JoinWaitlist(ctx, class.ID, m.ID); err != nil {
            t.Fatal(err)
        }
    }
    if err := svc.Cancel(ctx, b.ID, booker.ID); err != nil {
        t.Fatal(err)
    }
    if got := storetest.WaitlistStatus(t, db, class.ID, first.ID); got != store.WaitlistOffered {
        t.Errorf("first in line: %s, want offered", got)
    }
    if got := storetest.WaitlistStatus(t, db, class.ID, second.ID); got != store.WaitlistWaiting {
        t.Errorf("second in line: %s, want waiting", got)
    }
}
${concurrencyTest}`,
    'internal/booking/service.go': edits(
      ['// Cancel cancels one of a member\'s bookings, freeing the spot.', '// Cancel cancels one of a member\'s bookings and offers the freed spot to the waitlist.'],
      ['        _, err := store.CancelBooking(ctx, tx, bookingID, memberID)\n        return err', cancel],
    ),
    'internal/store/waitlist.go': append(`
// OfferSpot marks a waiting entry as offered a spot, held for them until holdUntil.
func OfferSpot(ctx context.Context, tx pgx.Tx, entryID int64, holdUntil time.Time) error {
    _, err := tx.Exec(ctx, \`
        UPDATE waitlist_entries SET status = 'offered', hold_until = $2
        WHERE id = $1 AND status = 'waiting'\`, entryID, holdUntil)
    return err
}

// TakeOffer accepts a member's open offer, if it's theirs and its hold hasn't run out.
func TakeOffer(ctx context.Context, tx pgx.Tx, entryID, memberID int64, now time.Time) (WaitlistEntry, error) {
    return scanWaitlistEntry(tx.QueryRow(ctx, \`
        UPDATE waitlist_entries SET status = 'accepted'
        WHERE id = $1 AND member_id = $2 AND status = 'offered' AND hold_until > $3
        RETURNING \`+waitlistColumns, entryID, memberID, now))
}
`),
    'internal/store/storetest/storetest.go': append(`
// WaitlistStatus is a member's status in a class's waitlist.
func WaitlistStatus(t *testing.T, db *store.DB, classID, memberID int64) store.WaitlistStatus {
    t.Helper()
    conn, err := pgx.Connect(context.Background(), os.Getenv("TEST_DATABASE_URL"))
    if err != nil {
        t.Fatal(err)
    }
    defer conn.Close(context.Background())
    var s store.WaitlistStatus
    err = conn.QueryRow(context.Background(), \`
        SELECT status FROM waitlist_entries WHERE class_id = $1 AND member_id = $2\`, classID, memberID).Scan(&s)
    if err != nil {
        t.Fatal(err)
    }
    return s
}
`),
    'internal/httpapi/offers.go': `package httpapi

import (
    "errors"
    "net/http"

    "${MOD}/internal/booking"
)

// POST /me/offers/{id}/accept takes a spot offered from the waitlist.
func (h *handlers) acceptOffer(w http.ResponseWriter, r *http.Request) {
    id, ok := pathID(w, r, "id")
    if !ok {
        return
    }
    b, err := h.bookings.AcceptOffer(r.Context(), id, memberFrom(r.Context()).ID)
    switch {
    case errors.Is(err, booking.ErrOfferGone):
        writeError(w, http.StatusGone, "offer_gone", "This spot is no longer held for you.")
    case err != nil:
        h.fail(w, r, err)
    default:
        writeJSON(w, http.StatusCreated, toBookingJSON(b))
    }
}
`,
    'internal/httpapi/router.go': after('        r.Delete("/me/bookings/{id}", h.cancelBooking)\n', '        r.Post("/me/offers/{id}/accept", h.acceptOffer)\n'),
  };
}

/** "Expire unconfirmed promotions after the hold window"; v2 has the call site adapted to v2 of "Promote…". */
function expiryChanges(v: 'v1' | 'v2'): Changes {
  const body =
    v === 'v1'
      ? `        err := s.db.Tx(ctx, func(tx pgx.Tx) error {
            ok, err := store.ExpireOffer(ctx, tx, e.ID, s.now())
            if err != nil || !ok {
                return err // !ok: accepted, or expired by another sweep, since we listed it
            }
            n++
            _, err = s.promoteFirstWaiting(ctx, tx, e.ClassID)
            return err
        })`
      : `        err := s.db.Tx(ctx, func(tx pgx.Tx) error {
            class, err := store.LockClass(ctx, tx, e.ClassID)
            if err != nil {
                return err
            }
            ok, err := store.ExpireOffer(ctx, tx, e.ID, s.now())
            if err != nil || !ok {
                return err // !ok: accepted, or expired by another sweep, since we listed it
            }
            n++
            _, err = s.promoteFirstWaiting(ctx, tx, class)
            return err
        })`;
  return {
    'internal/booking/expiry.go': `package booking

import (
    "context"

    "github.com/jackc/pgx/v5"

    "${MOD}/internal/store"
)

// ExpireHolds ends the offers whose hold has run out, and offers each of those spots to the next
// member in line. It returns how many offers it expired. The sweep-holds command runs it every
// few minutes; two sweeps at once are harmless.
func (s *Service) ExpireHolds(ctx context.Context) (int, error) {
    expired, err := s.db.ExpiredOffers(ctx, s.now())
    if err != nil {
        return 0, err
    }
    n := 0
    for _, e := range expired {
${body}
        if err != nil {
            return n, err
        }
    }
    return n, nil
}
`,
    'internal/store/waitlist.go': append(`
// ExpiredOffers lists offers whose hold ran out before now.
func (db *DB) ExpiredOffers(ctx context.Context, now time.Time) ([]WaitlistEntry, error) {
    rows, err := db.pool.Query(ctx, \`
        SELECT \`+waitlistColumns+\` FROM waitlist_entries
        WHERE status = 'offered' AND hold_until <= $1
        ORDER BY hold_until LIMIT 500\`, now)
    if err != nil {
        return nil, err
    }
    return pgx.CollectRows(rows, func(row pgx.CollectableRow) (WaitlistEntry, error) { return scanWaitlistEntry(row) })
}

// ExpireOffer ends an offer whose hold has run out. It reports false if the offer was accepted or
// expired in the meantime.
func ExpireOffer(ctx context.Context, tx pgx.Tx, entryID int64, now time.Time) (bool, error) {
    tag, err := tx.Exec(ctx, \`
        UPDATE waitlist_entries SET status = 'expired'
        WHERE id = $1 AND status = 'offered' AND hold_until <= $2\`, entryID, now)
    return tag.RowsAffected() == 1, err
}
`),
    'cmd/orchard-api/sweep.go': `package main

import (
    "context"
    "log/slog"

    "${MOD}/internal/booking"
)

// sweepHolds is \`orchard-api sweep-holds\`: expire waitlist offers nobody took in time. It runs as a
// Kubernetes CronJob (orchard-infra: k8s/api/cronjobs.yaml).
func sweepHolds(ctx context.Context, bookings *booking.Service, log *slog.Logger) int {
    n, err := bookings.ExpireHolds(ctx)
    if err != nil {
        log.Error("sweep holds", "err", err, "expired", n)
        return 1
    }
    log.Info("swept holds", "expired", n)
    return 0
}
`,
    'cmd/orchard-api/main.go': replace(
      '    bookings := booking.NewService(db, mailer)\n',
      `    bookings := booking.NewService(db, mailer)
    if len(os.Args) > 1 && os.Args[1] == "sweep-holds" {
        os.Exit(sweepHolds(ctx, bookings, log))
    }
`,
    ),
    'README.md': append(`
## Commands

\`orchard-api sweep-holds\` expires waitlist offers whose hold window (two hours) has passed and offers
those spots to the next person in line. Production runs it every five minutes.
`),
  };
}
