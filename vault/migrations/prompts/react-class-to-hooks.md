# Migration: React Class Components → Hooks

## Trigger Keywords
react, class component, hooks, useState, useEffect, componentDidMount, componentDidUpdate, lifecycle, PureComponent, extends Component

## Languages
TypeScript, JavaScript, TSX, JSX

## What to Change
1. Replace `class Foo extends React.Component` with `function Foo(props)`
2. Replace `class Foo extends React.PureComponent` with `function Foo(props)` + `React.memo()` wrapper
3. Convert `this.state = { x }` → `const [x, setX] = useState(initialValue)`
4. Convert `this.setState({ x: val })` → `setX(val)`
5. Convert `componentDidMount` → `useEffect(() => { ... }, [])`
6. Convert `componentDidUpdate(prevProps, prevState)` → `useEffect(() => { ... }, [deps])`
7. Convert `componentWillUnmount` → return a cleanup function from `useEffect`
8. Convert `this.props.foo` → `props.foo` (or destructure: `const { foo } = props`)
9. Convert `this.context` → `useContext(Context)`
10. Convert class methods bound in constructor → plain function declarations inside the function component
11. Remove constructor, render(), and `this` references entirely

## Before
```tsx
class UserCard extends React.Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { count: 0, loading: true };
    this.handleClick = this.handleClick.bind(this);
  }

  componentDidMount() {
    this.setState({ loading: false });
  }

  componentDidUpdate(prevProps: Props) {
    if (prevProps.userId !== this.props.userId) {
      this.setState({ count: 0 });
    }
  }

  handleClick() {
    this.setState({ count: this.state.count + 1 });
  }

  render() {
    return <div onClick={this.handleClick}>{this.state.count}</div>;
  }
}
```

## After
```tsx
function UserCard({ userId }: Props) {
  const [count, setCount] = useState(0);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(false);
  }, []);

  useEffect(() => {
    setCount(0);
  }, [userId]);

  function handleClick() {
    setCount(c => c + 1);
  }

  return <div onClick={handleClick}>{count}</div>;
}
```

## Edge Cases
- `shouldComponentUpdate`: replace with `React.memo(Foo, (prevProps, nextProps) => ...)`
- `getDerivedStateFromProps`: convert to `useMemo` or derive in render body
- `getSnapshotBeforeUpdate`: rarely used — add `// TODO: manual review needed` comment
- `componentDidCatch` / `getDerivedStateFromError`: keep as class component (error boundaries cannot be hooks yet)
- `this.setState` updater form `setState(prev => ...)` → `setX(prev => ...)`
- Context via `static contextType`: replace with `useContext(MyContext)`
- Refs via `createRef()` → `useRef()`

## Forbidden Patterns
- `extends React.Component`
- `extends React.PureComponent`
- `this.state`
- `this.setState`
- `this.props`
- `componentDidMount`
- `componentDidUpdate`
- `componentWillUnmount`
- `render() {`

## Acceptance Criteria
- [ ] No class component syntax remains
- [ ] All lifecycle methods converted to hooks
- [ ] All `this.` references removed
- [ ] TypeScript types preserved on props
- [ ] Component renders identically (no logic changes)
- [ ] Build passes
- [ ] All existing tests pass
