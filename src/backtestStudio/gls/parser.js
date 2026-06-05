const KEYWORDS = new Set([
  'strategy', 'param', 'let', 'if', 'else', 'true', 'false', 'null',
  'onEventStart', 'onTick', 'onEventEnd',
]);

const IDENT_LIKE_KEYWORDS = new Set([
  'state', 'params', 'position', 'runState', 'tick', 'event', 'samples',
]);

export function parse(source) {
  const lexer = createLexer(String(source || ''));
  const parser = new Parser(lexer);
  return parser.parseStrategy();
}

function createLexer(source) {
  let pos = 0;
  let line = 1;
  let column = 1;

  function peek(offset = 0) {
    return source[pos + offset] ?? '';
  }

  function advance() {
    const ch = source[pos++];
    if (ch === '\n') {
      line += 1;
      column = 1;
    } else {
      column += 1;
    }
    return ch;
  }

  function skipWhitespaceAndComments() {
    while (pos < source.length) {
      const ch = peek();
      if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n') {
        advance();
        continue;
      }
      if (ch === '/' && peek(1) === '/') {
        while (pos < source.length && peek() !== '\n') advance();
        continue;
      }
      break;
    }
  }

  function makeToken(type, value, startLine = line, startColumn = column) {
    return { type, value, line: startLine, column: startColumn };
  }

  function readString() {
    const startLine = line;
    const startColumn = column;
    advance();
    let value = '';
    while (pos < source.length) {
      const ch = peek();
      if (ch === '"') {
        advance();
        return makeToken('string', value, startLine, startColumn);
      }
      if (ch === '\\') {
        advance();
        const esc = advance();
        value += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc;
        continue;
      }
      if (ch === '\n') throw syntaxError('Unterminated string', startLine, startColumn);
      value += advance();
    }
    throw syntaxError('Unterminated string', startLine, startColumn);
  }

  function readNumber() {
    const startLine = line;
    const startColumn = column;
    let value = '';
    while (/[0-9.]/.test(peek())) value += advance();
    const num = Number(value);
    if (!Number.isFinite(num)) throw syntaxError(`Invalid number: ${value}`, startLine, startColumn);
    return makeToken('number', num, startLine, startColumn);
  }

  function readIdentifier() {
    const startLine = line;
    const startColumn = column;
    let value = '';
    while (/[A-Za-z0-9_]/.test(peek())) value += advance();
    const type = KEYWORDS.has(value) ? 'keyword' : 'ident';
    return makeToken(type, value, startLine, startColumn);
  }

  function nextToken() {
    skipWhitespaceAndComments();
    if (pos >= source.length) return makeToken('eof', '', line, column);
    const ch = peek();
    const startLine = line;
    const startColumn = column;

    if (ch === '"') return readString();
    if (/[0-9]/.test(ch)) return readNumber();
    if (/[A-Za-z_]/.test(ch)) return readIdentifier();

    const two = ch + peek(1);
    const ops = ['==', '!=', '<=', '>=', '&&', '||'];
    if (ops.includes(two)) {
      advance(); advance();
      return makeToken('op', two, startLine, startColumn);
    }
    if ('=!<>+-*/'.includes(ch)) {
      advance();
      return makeToken('op', ch, startLine, startColumn);
    }
    if ('{}()[],.:'.includes(ch)) {
      advance();
      return makeToken('punct', ch, startLine, startColumn);
    }
    throw syntaxError(`Unexpected character: ${ch}`, startLine, startColumn);
  }

  let buffered = null;

  function snapshot() {
    return { pos, line, column, buffered, current: module.current };
  }

  function restore(state) {
    pos = state.pos;
    line = state.line;
    column = state.column;
    buffered = state.buffered;
    module.current = state.current;
  }

  const module = {
    next() {
      if (buffered) {
        const token = buffered;
        buffered = null;
        this.current = token;
        return token;
      }
      const token = nextToken();
      this.current = token;
      return token;
    },
    peek() {
      if (!buffered) buffered = nextToken();
      return buffered;
    },
    snapshot,
    restore,
    current: null,
    line() { return line; },
    column() { return column; },
  };

  return module;
}

class Parser {
  constructor(lexer) {
    this.lexer = lexer;
    this.current = lexer.next();
    this.lastToken = this.current;
  }

  parseStrategy() {
    this.expectKeyword('strategy');
    const nameToken = this.expectType('string');
    this.expectPunct('{');
    const params = [];
    const hooks = {};
    while (!this.checkPunct('}') && !this.checkType('eof')) {
      if (this.checkKeyword('param')) {
        params.push(this.parseParam());
        continue;
      }
      if (this.checkHook()) {
        const hook = this.parseHook();
        hooks[hook.name] = hook;
        continue;
      }
      throw syntaxError(`Unexpected token in strategy body: ${this.current.value}`, this.current.line, this.current.column);
    }
    this.expectPunct('}');
    return {
      type: 'Strategy',
      name: nameToken.value,
      params,
      hooks,
      loc: { line: nameToken.line, column: nameToken.column },
    };
  }

  parseParam() {
    this.expectKeyword('param');
    const name = this.expectType('ident').value;
    this.expectOp('=');
    const defaultValue = this.parseLiteral();
    return { name, default: defaultValue };
  }

  parseHook() {
    const name = this.current.value;
    this.advance();
    this.expectPunct('(');
    const args = [];
    if (!this.checkPunct(')')) {
      do {
        args.push(this.expectIdentLike().value);
      } while (this.matchPunct(','));
    }
    this.expectPunct(')');
    const body = this.parseBlock();
    return { name, args, body };
  }

  parseBlock() {
    this.expectPunct('{');
    const body = [];
    while (!this.checkPunct('}') && !this.checkType('eof')) {
      body.push(this.parseStatement());
    }
    this.expectPunct('}');
    return body;
  }

  parseStatement() {
    if (this.checkKeyword('let')) return this.parseLet();
    if (this.checkKeyword('if')) return this.parseIf();
    if (this.checkAssignStart()) return this.parseAssign();
    const expr = this.parseExpression();
    return { type: 'ExprStmt', expr, loc: locOf(expr) };
  }

  parseLet() {
    const start = this.current;
    this.expectKeyword('let');
    const name = this.expectType('ident').value;
    this.expectOp('=');
    const value = this.parseExpression();
    return { type: 'Let', name, value, loc: { line: start.line, column: start.column } };
  }

  parseAssign() {
    const target = this.parseLValue();
    this.expectOp('=');
    const value = this.parseExpression();
    return { type: 'Assign', target, value, loc: locOf(target) };
  }

  parseIf() {
    const start = this.current;
    this.expectKeyword('if');
    this.expectPunct('(');
    const test = this.parseExpression();
    this.expectPunct(')');
    const consequent = this.parseBlock();
    let alternate = null;
    if (this.matchKeyword('else')) alternate = this.parseBlock();
    return { type: 'If', test, consequent, alternate, loc: { line: start.line, column: start.column } };
  }

  parseExpression() {
    return this.parseOr();
  }

  parseOr() {
    let node = this.parseAnd();
    while (this.matchOp('||')) {
      node = { type: 'Binary', operator: '||', left: node, right: this.parseAnd(), loc: locOf(node) };
    }
    return node;
  }

  parseAnd() {
    let node = this.parseEquality();
    while (this.matchOp('&&')) {
      node = { type: 'Binary', operator: '&&', left: node, right: this.parseEquality(), loc: locOf(node) };
    }
    return node;
  }

  parseEquality() {
    let node = this.parseComparison();
    while (this.matchOp('==', '!=')) {
      const op = this.previous().value;
      node = { type: 'Binary', operator: op, left: node, right: this.parseComparison(), loc: locOf(node) };
    }
    return node;
  }

  parseComparison() {
    let node = this.parseAdditive();
    while (this.matchOp('<', '<=', '>', '>=')) {
      const op = this.previous().value;
      node = { type: 'Binary', operator: op, left: node, right: this.parseAdditive(), loc: locOf(node) };
    }
    return node;
  }

  parseAdditive() {
    let node = this.parseMultiplicative();
    while (this.matchOp('+', '-')) {
      const op = this.previous().value;
      node = { type: 'Binary', operator: op, left: node, right: this.parseMultiplicative(), loc: locOf(node) };
    }
    return node;
  }

  parseMultiplicative() {
    let node = this.parseUnary();
    while (this.matchOp('*', '/')) {
      const op = this.previous().value;
      node = { type: 'Binary', operator: op, left: node, right: this.parseUnary(), loc: locOf(node) };
    }
    return node;
  }

  parseUnary() {
    if (this.matchOp('!')) {
      const argument = this.parseUnary();
      return { type: 'Unary', operator: '!', argument, loc: locOf(argument) };
    }
    return this.parsePostfix();
  }

  parsePostfix() {
    let node = this.parsePrimary();
    while (true) {
      if (this.matchPunct('.')) {
        const property = this.expectType('ident').value;
        node = { type: 'Member', object: node, property, loc: locOf(node) };
        continue;
      }
      if (this.matchPunct('(')) {
        const args = [];
        if (!this.checkPunct(')')) {
          do {
            args.push(this.parseExpression());
          } while (this.matchPunct(','));
        }
        this.expectPunct(')');
        node = { type: 'Call', callee: node, args, loc: locOf(node) };
        continue;
      }
      break;
    }
    return node;
  }

  parsePrimary() {
    if (this.matchKeyword('true')) return { type: 'Literal', value: true, loc: locOfToken(this.previous()) };
    if (this.matchKeyword('false')) return { type: 'Literal', value: false, loc: locOfToken(this.previous()) };
    if (this.matchKeyword('null')) return { type: 'Literal', value: null, loc: locOfToken(this.previous()) };
    if (this.matchType('number')) return { type: 'Literal', value: this.previous().value, loc: locOfToken(this.previous()) };
    if (this.matchType('string')) return { type: 'Literal', value: this.previous().value, loc: locOfToken(this.previous()) };
    if (this.matchIdentLike()) {
      const name = this.previous().value;
      return { type: 'Identifier', name, loc: locOfToken(this.previous()) };
    }
    if (this.matchPunct('(')) {
      const expr = this.parseExpression();
      this.expectPunct(')');
      return expr;
    }
    if (this.matchPunct('{')) {
      return this.parseObjectLiteral(locOfToken(this.previous()));
    }
    throw syntaxError(`Unexpected token: ${this.current.value}`, this.current.line, this.current.column);
  }

  parseObjectLiteral(start) {
    const properties = [];
    while (!this.checkPunct('}') && !this.checkType('eof')) {
      let key;
      if (this.matchType('string')) key = this.previous().value;
      else key = this.expectIdentLike().value;
      this.expectPunct(':');
      properties.push({ key, value: this.parseExpression() });
      if (!this.matchPunct(',')) break;
    }
    this.expectPunct('}');
    return { type: 'ObjectLiteral', properties, loc: start };
  }

  parseLiteral() {
    const node = this.parsePrimary();
    if (node.type !== 'Literal') {
      throw syntaxError('Expected literal value', node.loc?.line ?? this.current.line, node.loc?.column ?? this.current.column);
    }
    return node.value;
  }

  parseLValue() {
    let node = { type: 'Identifier', name: this.expectIdentLike().value, loc: locOfToken(this.previous()) };
    while (this.matchPunct('.')) {
      const property = this.expectType('ident').value;
      node = { type: 'Member', object: node, property, loc: locOf(node) };
    }
    return node;
  }

  checkAssignStart() {
    if (!this.checkType('ident') && !this.checkIdentLikeKeyword()) return false;
    const snap = this.lexer.snapshot();
    try {
      let token = this.lexer.peek();
      while (token.type === 'punct' && token.value === '.') {
        this.lexer.next();
        this.lexer.next();
        token = this.lexer.peek();
      }
      return token.type === 'op' && token.value === '=';
    } finally {
      this.lexer.restore(snap);
    }
  }

  checkHook() {
    return this.checkKeyword('onEventStart') || this.checkKeyword('onTick') || this.checkKeyword('onEventEnd');
  }

  expectKeyword(value) {
    if (!this.checkKeyword(value)) {
      throw syntaxError(`Expected keyword ${value}`, this.current.line, this.current.column);
    }
    return this.advance();
  }

  expectIdentLike() {
    if (this.checkType('ident') || this.checkIdentLikeKeyword()) {
      return this.advance();
    }
    throw syntaxError('Expected identifier', this.current.line, this.current.column);
  }

  checkIdentLikeKeyword() {
    return this.current.type === 'keyword' && IDENT_LIKE_KEYWORDS.has(this.current.value);
  }

  matchIdentLike() {
    if (this.checkType('ident') || this.checkIdentLikeKeyword()) {
      this.advance();
      return true;
    }
    return false;
  }

  expectType(type) {
    if (!this.checkType(type)) {
      throw syntaxError(`Expected ${type}`, this.current.line, this.current.column);
    }
    return this.advance();
  }

  expectPunct(value) {
    if (!this.checkPunct(value)) {
      throw syntaxError(`Expected ${value}`, this.current.line, this.current.column);
    }
    return this.advance();
  }

  expectOp(value) {
    if (!this.checkOp(value)) {
      throw syntaxError(`Expected operator ${value}`, this.current.line, this.current.column);
    }
    return this.advance();
  }

  checkKeyword(value) {
    return this.current.type === 'keyword' && this.current.value === value;
  }

  checkType(type) {
    return this.current.type === type;
  }

  checkPunct(value) {
    return this.current.type === 'punct' && this.current.value === value;
  }

  checkOp(value) {
    return this.current.type === 'op' && this.current.value === value;
  }

  matchKeyword(...values) {
    for (const value of values) {
      if (this.checkKeyword(value)) {
        this.advance();
        return true;
      }
    }
    return false;
  }

  matchType(type) {
    if (this.checkType(type)) {
      this.advance();
      return true;
    }
    return false;
  }

  matchPunct(value) {
    if (this.checkPunct(value)) {
      this.advance();
      return true;
    }
    return false;
  }

  matchOp(...values) {
    for (const value of values) {
      if (this.checkOp(value)) {
        this.advance();
        return true;
      }
    }
    return false;
  }

  advance() {
    this.lastToken = this.current;
    if (!this.checkType('eof')) this.current = this.lexer.next();
    return this.lastToken;
  }

  previous() {
    return this.lastToken;
  }
}

function locOf(node) {
  return node?.loc ?? { line: 1, column: 1 };
}

function locOfToken(token) {
  return { line: token.line, column: token.column };
}

export function syntaxError(message, line, column) {
  const err = new Error(message);
  err.line = line;
  err.column = column;
  err.code = 'SYNTAX_ERROR';
  return err;
}

export function extractParamsSchema(ast) {
  const schema = {};
  for (const param of ast.params || []) {
    schema[param.name] = { default: param.default };
  }
  return schema;
}
