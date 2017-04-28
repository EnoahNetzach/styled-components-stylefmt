import traverse from 'babel-traverse'
import { parse, tokTypes } from 'babylon'
import crypto from 'crypto'
import deasync from 'deasync'
import escapeStringRegexp from 'escape-string-regexp'
import fs from 'fs'
import indentString from 'indent-string'
import { EOL } from 'os'
import postcss from 'postcss'
import stylefmt from 'stylefmt'
import { isHelper, isStyled, isStyledImport } from 'stylelint-processor-styled-components/lib/utils/styled'
import { parseImports } from 'stylelint-processor-styled-components/lib/utils/parse'
import { fixIndentation, wrapKeyframes, wrapSelector } from 'stylelint-processor-styled-components/lib/utils/general'
import {
  getTaggedTemplateLiteralContent,
} from 'stylelint-processor-styled-components/lib/utils/tagged-template-literal'

const getHash = string => crypto.createHash('md5').update(string).digest('hex').substr(0, 8)

const resolvePromise = (promise) => {
  const guard = Symbol('deasync guard')
  let result = guard

  promise.then((res) => {
    result = res
  })
  deasync.loopWhile(() => result === guard)

  return result
}

const escapedEOL = escapeStringRegexp(EOL)

const closingTokens = [tokTypes.bracketR, tokTypes.braceR, tokTypes.braceBarR, tokTypes.parenR, tokTypes.backQuote]
  .map(({ label }) => label)
  .map(escapeStringRegexp)

const closingRegexp = new RegExp(`^\\s*((?:${closingTokens.join('|')}|\\s)+)\\s*${closingTokens[1]}.*$`, 'm')

const getClosingLineTokens = (line) => {
  const matches = line.match(closingRegexp)

  return matches && matches[1]
}

export default (inputPath, options = {}) => {
  const input = fs.readFileSync(inputPath).toString()
  const lines = input.split(EOL)
  let output = input
  let offset = 0

  const ast = parse(input, {
    sourceType: 'module',
    plugins: [
      'jsx',
      'flow',
      'objectRestSpread',
      'decorators',
      'classProperties',
      'exportExtensions',
      'asyncGenerators',
      'functionBind',
      'functionSent',
      'dynamicImport',
    ],
  })

  let importedNames = {
    default: 'styled',
    css: 'css',
    keyframes: 'keyframes',
    injectGlobal: 'injectGlobal',
  }

  traverse(ast, {
    enter({ node }) {
      if (isStyledImport(node)) {
        importedNames = parseImports(node)
        return
      }

      const helper = isHelper(node, importedNames)

      if (!helper && !isStyled(node, importedNames.default)) {
        return
      }

      const nodeIndentation = lines[node.loc.start.line - 1].match(/(\s*)/)[1]

      const expressionSourceMap = []

      node.quasi.expressions.forEach((expression, index) => {
        const sourceCode = input.substring(expression.start, expression.end)
        const hash = getHash(sourceCode)

        const startLine = expression.loc.start.line
        const endLine = expression.loc.end.line
        const multiLine = startLine !== endLine

        const closingLineTokens = multiLine ? getClosingLineTokens(lines[endLine - 1]) : null

        const endsWithSemicolon = lines[endLine - 1].match(/(;)\s*$/) !== null

        expressionSourceMap.push({
          closingLineTokens,
          endsWithSemicolon,
          hash,
          sourceCode,
        })

        // eslint-disable-next-line no-param-reassign
        node.quasi.expressions[index].name = `quasiExpr_${hash}`
      })

      const content = getTaggedTemplateLiteralContent(node)
      const fixedContent = fixIndentation(content).text
      const wrapperFn = helper === 'keyframes' ? wrapKeyframes : wrapSelector
      const wrappedContent = wrapperFn(fixedContent)
      const isWrapped = wrappedContent !== fixedContent

      const { css } = resolvePromise(postcss([stylefmt(options)]).process(wrappedContent, { from: inputPath }))
      const indentedCss = indentString(css, 1, nodeIndentation)

      const formatted = expressionSourceMap.reduce(
        (all, { closingLineTokens, endsWithSemicolon, hash, sourceCode }) => {
          const hashedExpression = `quasiExpr_${hash}${endsWithSemicolon ? '' : ';'}`

          if (closingLineTokens !== null) {
            const firstLineIndentation = indentedCss.match(new RegExp(`^(\\s*).*${hashedExpression}`, 'm'))[1]

            const sourceCodeWithoutLastLine = sourceCode.split(EOL).slice(0, -1).join(EOL)

            return all.replace(
              hashedExpression,
              `{${sourceCodeWithoutLastLine}${EOL}${firstLineIndentation}${closingLineTokens}}`,
            )
          }

          return all.replace(hashedExpression, `{${sourceCode}}`)
        },
        indentedCss,
      )

      const formattedHash = getHash(formatted)
      const unwrapperFn = (string) => {
        const escapedString = escapeStringRegexp(
          helper === 'keyframes' ? wrapKeyframes(formattedHash) : wrapSelector(formattedHash),
        )

        const unwrappingString = escapedString
          .replace(/\s+/, '\\s*')
          .replace(EOL, `(?:${escapedEOL})*`)
          .replace(new RegExp(`${escapedEOL}*${formattedHash}${escapedEOL}*`), `${escapedEOL}*((?:.|[\\r\\n])+)`)

        const unwrappingRegexp = new RegExp(`^\\s*${unwrappingString}$`, 'm')

        return string.replace(/-styled-mixin: /g, '$').match(unwrappingRegexp)[1]
      }

      const unwrapped = isWrapped ? unwrapperFn(formatted) : formatted

      const templateLiteral = `\`\n${unwrapped}\``

      const pre = output.substring(0, node.quasi.start + offset)
      const post = output.substring(node.quasi.end + offset)
      output = `${pre}${templateLiteral}${post}`

      offset += templateLiteral.length - (node.quasi.end - node.quasi.start)
    },
  })

  return output
}
