import tseslint from 'typescript-eslint'

export default tseslint.config(
  { ignores: ['out/**', 'node_modules/**'] },
  ...tseslint.configs.recommended
)
