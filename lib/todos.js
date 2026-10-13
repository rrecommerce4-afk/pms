const { load, save } = require('../db');

// Personal To Do List — a plain tick-off list per user (not workflow tasks: no review,
// no dates). Registered on both the admin and employee routers so each keeps its own
// sidebar/nav locals; items are always scoped to the logged-in user.
function registerTodoRoutes(router) {
  function myTodo(db, req) {
    return db.todos.find((x) => x.id === Number(req.params.id) && x.userId === req.session.userId);
  }

  function back(req) {
    return req.baseUrl + '/todos';
  }

  router.get('/todos', (req, res) => {
    const db = load();
    const todos = db.todos.filter((x) => x.userId === req.session.userId);
    res.render('todos', {
      crumb: 'To Do List', heading: 'To Do List',
      todos,
      doneCount: todos.filter((x) => x.done).length,
      basePath: req.baseUrl
    });
  });

  router.post('/todos', (req, res) => {
    const db = load();
    const text = (req.body.text || '').trim();
    if (text) {
      db.todos.push({ id: db.nextId.todos++, userId: req.session.userId, text, done: false, createdAt: new Date().toISOString(), doneAt: null });
      save(db);
    }
    res.redirect(back(req));
  });

  router.post('/todos/:id/toggle', (req, res) => {
    const db = load();
    const todo = myTodo(db, req);
    if (todo) {
      todo.done = !todo.done;
      todo.doneAt = todo.done ? new Date().toISOString() : null;
      save(db);
    }
    // The page ticks items in place via fetch — no need to reload it.
    if (req.get('X-Requested-With') === 'fetch') return res.json({ ok: !!todo, done: todo ? todo.done : false });
    res.redirect(back(req));
  });

  router.post('/todos/:id/delete', (req, res) => {
    const db = load();
    const todo = myTodo(db, req);
    if (todo) { db.todos.splice(db.todos.indexOf(todo), 1); save(db); }
    res.redirect(back(req));
  });

  router.post('/todos/clear-done', (req, res) => {
    const db = load();
    db.todos = db.todos.filter((x) => !(x.userId === req.session.userId && x.done));
    save(db);
    res.redirect(back(req));
  });
}

module.exports = { registerTodoRoutes };
