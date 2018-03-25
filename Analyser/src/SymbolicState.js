/* Copyright (c) Royal Holloway, University of London | Contact Blake Loring (blake@parsed.uk), Duncan Mitchell (Duncan.Mitchell.2015@rhul.ac.uk), or Johannes Kinder (johannes.kinder@rhul.ac.uk) for details or support | LICENSE.md for license details */

"use strict";


import Config from './Config';
import Log from './Utilities/Log';
import ObjectHelper from './Utilities/ObjectHelper';
import Coverage from './Coverage';
import {WrappedValue, ConcolicValue} from './Values/WrappedValue';

import External from './External';

const Stats = External('Stats');
const Z3 = External('z3javascript');

Z3.Query.MAX_REFINEMENTS = 20;

//60s default timeout
const DEFAULT_CONTEXT_TIMEOUT = 5 * 60 * 1000;

class SymbolicState {
    constructor(input, sandbox) {


        this.ctx = new Z3.Context();
        this.slv = new Z3.Solver(this.ctx, DEFAULT_CONTEXT_TIMEOUT);

        this.input = input;

        this.boolSort = this.ctx.mkBoolSort();
        this.stringSort = this.ctx.mkStringSort();
        this.realSort = this.ctx.mkRealSort();

        this.coverage = new Coverage(sandbox);

        this.inputSymbols = {};

        this.pathCondition = [];
        this.errors = [];

        this.stats = new Stats();
    }

    getErrorCount() {
        return this.errors.length;
    }

    addError(error) {
        this.errors.push(error);
    }
    
    pushCondition(cnd, binder) {
    	this.pathCondition.push({
            ast: cnd,
            binder: binder || false,
            forkIid: this.coverage.last()
        });
    }

    pushNot(cnd) {
        this.pushCondition(this.ctx.mkNot(cnd));
    }

    symbolicConditional(result) {
        let [result_s, result_c] = [this.getSymbolic(result), this.getConcrete(result)];

        if (result_c === true) {
            Log.logMid("Concrete result was true, pushing " + result_s);
            this.pushCondition(result_s);
        } else if (result_c === false) {
            Log.logMid("Concrete result was false, pushing not of " + result_s);
            this.pushNot(result_s);
        } else {
            Log.log("Result: " + result_c.toString() + ' and ' + result_s.toString() + " (" + typeof(result_c) + ")");
            Log.log("Undefined result not yet supported");
        }

        return result_c;
    }

    /**
     * Roll PC into a single AND'ed PC
     */
    _simplifyPC(pc) {
        return pc.reduce((prev, current) => this.ctx.mkAnd(prev, current)).simplify();
    }

    /**
     *Formats PC to pretty string if length != 0
     */
    _stringPC(pc) {
        if (pc.length) {
            return this._simplifyPC(pc).toPrettyString();
        } else {
            return "";
        }
    }

    /**
     * Returns the final PC as a string (if any symbols exist)
     */
    finalPC() {
        return this._stringPC(this.pathCondition.filter(x => x.ast).map(x => x.ast));
    }

    /**
     * Regenerate the final input object from the path condition (for output)
     * Use initial input if the PC couldn't be satisfied (Some serious issues has occured)
     */
    finalInput() {
        return this.input;
    }

    _buildPC(childInputs, i) {
        let newPC = this.ctx.mkNot(this.pathCondition[i].ast);
        
        let allChecks = this.pathCondition.slice(0, i).reduce((last, next) => last.concat(next.ast.checks.trueCheck), []).concat(newPC.checks.trueCheck);

        Log.logMid('Checking if ' + ObjectHelper.asString(newPC) + ' is satisfiable with checks ' + allChecks.length);

        let solution = this._checkSat(newPC, allChecks);

        if (solution) {
            solution._bound = i + 1;
            
            childInputs.push({
                input: solution,
                pc: this._stringPC(newPC),
                forkIid: this.pathCondition[i].forkIid
            });
           
            Log.logMid("Satisfiable. Remembering new input: " + ObjectHelper.asString(solution));
        } else {
            Log.logMid("Unsatisfiable.");
        }
    }

    alternatives() {
        let childInputs = [];

        if (this.input._bound > this.pathCondition.length) {
            Log.log('Bound > PathCondition');
            throw 'This path has diverged';
        }

        //Push all PCs up until bound
        for (let i = 0; i < Math.min(this.input._bound, this.pathCondition.length); i++) {
            this.slv.assert(this.pathCondition[i].ast);
        }

        this.slv.push();

        for (let i = this.input._bound; i < this.pathCondition.length; i++) {

            //TODO: Make checks on expressions smarter
            if (!this.pathCondition[i].binder) {
                this._buildPC(childInputs, i);
            }
                
            //Push the current thing we're looking at to the solver
            this.slv.assert(this.pathCondition[i].ast);

            this.slv.push();
        }

        this.slv.reset();

        // Generational search would now Run&Check all new child inputs
        return childInputs;
    }

    _getSort(concrete) {
        switch (typeof concrete) {
            case 'boolean':
                return this.boolSort;
                break;

            case 'number':
                return this.realSort;
                break;

            case 'string':
                return this.stringSort;
                break;
            default:
                Log.log("Symbolic input variable of type " + typeof val + " not yet supported.");
        }
    }

    makeArray(concrete, name) {
        // TODO (AF) Fix this to defer array reasoning for empty arrays
        let sort = concrete.length > 0 ? this._getSort(concrete[0]) : this.realSort;
        return this.ctx.mkArray(name, sort);
    }

    createSymbolicValue(name, concrete) {

        let symbolic;
        
        // Keep our arrays homogenous for now
        if (Config.arraysEnabled && concrete instanceof Array && (concrete.length === 0 || concrete.every(i => typeof i === typeof concrete[0]))) {
            symbolic = this.makeArray(concrete, name);
            // Array length is greater than 0
            this.pushCondition(this.ctx.mkGe(symbolic.getLength(), this.ctx.mkIntVal(0)), true);
        } else {
            let sort = this._getSort(concrete);
            if (sort) {
                let symbol = this.ctx.mkStringSymbol(name);
                
                symbolic = this.ctx.mkConst(symbol, sort);
            }
        }

        // Use generated input if available
        if (name in this.input) {
            concrete = this.input[name];
        } else {
            this.input[name] = concrete;
        }

        this.inputSymbols[name] = symbolic;

        Log.logMid("Initializing fresh symbolic variable \"" + symbolic + "\" using concrete value \"" + concrete + "\"");
        return new ConcolicValue(concrete, symbolic);
    }

    getSolution(model) {
    	let solution = {};

        for (let name in this.inputSymbols) {
            let solutionAst = model.eval(this.inputSymbols[name]);
            solution[name] = solutionAst.asConstant(model);
            solutionAst.destroy();
        }

        model.destroy();
        return solution;
    }

    _checkSat(clause, checks) {
        Log.log('Checks length ' + checks.length);
        let model = (new Z3.Query([clause], checks)).getModel(this.slv);
        return model ? this.getSolution(model) : undefined;
    }

    isSymbolic(val) {
        return !!ConcolicValue.getSymbolic(val);
    }

    getSymbolic(val) {
        return ConcolicValue.getSymbolic(val);
    }

    isWrapped(val) {
        return WrappedValue.isWrapped(val);
    }

    getConcrete(val) {
        return WrappedValue.getConcrete(val);
    }

    asSymbolic(val) {
        return this.getSymbolic(val) || this.wrapConstant(val);
    }

    getAnnotations(val) {
        return WrappedValue.getAnnotations(val);
    }

    symbolicBinary(op, left_c, left_s, right_c, right_s) {
        
        const is_null = left_c === null || right_c === null || left_c === undefined || right_c === undefined;

        if (is_null || typeof right_c != typeof left_c) {
            return undefined;
        }	
        
        let ctx = this.ctx;

        /**
         * TODO: The following code forces coercions to int, rather than
         * Letting the default upgrading to reals happen.
         * This is awful code to fix a silly bug in Z3
         * Remove ASAP
         */
        function coerceInt(s) {
            if (!s.FORCE_EQ_TO_INT) {
                return ctx.mkRealToInt(s);
            }
            return s;
        }

        let result;

        switch (op) {
        case "===":
        case "==":
            result = this.ctx.mkEq(left_s, right_s);
            break;
        case "!==":
        case "!=":
            result = this.ctx.mkNot(this.ctx.mkEq(left_s, right_s));
            break;
        case "&&":
            result = this.ctx.mkAnd(left_s, right_s);
            break;
        case "||":
            result = this.ctx.mkOr(left_s, right_s);
            break;
        case ">":
            result = this.ctx.mkGt(left_s, right_s);
            break;
        case ">=":
            result = this.ctx.mkGe(left_s, right_s);
            break;
        case "<=":
            result = this.ctx.mkLe(left_s, right_s);
            break;
        case "<":
            result = this.ctx.mkLt(left_s, right_s);
            break;
        case "+":
            if (typeof left_c == "string") {
                result = this.ctx.mkSeqConcat([left_s, right_s]);
            } else {
            	    result = this.ctx.mkAdd(left_s, right_s);
            }
            break;
        case "-":
            result = this.ctx.mkSub(left_s, right_s);
            break;
        case "*":
            result = this.ctx.mkMul(left_s, right_s);
            break;
        case "/":
            result = this.ctx.mkDiv(left_s, right_s);
            break;
        case "%":
            result = this.ctx.mkMod(left_s, right_s);
            break;
        default:
            Log.log("Symbolic execution does not support operand \"" + op + "\", concretizing.");
            return undefined;
        }

        return result;
    }

    symbolicSetField(base_c, base_s, field_c, field_s, val_c, val_s) {
        if (Config.arraysEnabled && base_c instanceof Array ) {
            const array = base_s;
            Log.logMid(`Set Field with ${field_c} and ${val_c}`)
            // TODO Consider how to handle making arrays non-homogenous
            if (Number.isInteger(field_c) && field_c >= 0 && field_c < 4294967295 && base_s.getType() === typeof val_c) {
                const newArray = array.setAtIndex(this.ctx.mkRealToInt(field_s), val_s);
                const newLength = this.ctx.mkIntVar(`${array.getName()}_Length_${array.incrementLengthCounter()}`);
                newArray.setLength(newLength);
                base_s.symbolic = newArray;
               
                this.pushCondition(this.ctx.mkGe(array.getLength(), this.ctx.mkAdd(field_s, this.ctx.mkIntVal(1))));
                
                const isOutsideBounds = field_c > base_c.length;
                if (!isOutsideBounds) {
                    Log.log('Setting outside existing known length, unmodelled holes may have been created within array');
                }
            } else if (field_c === "length" && Number.isInteger(val_c)) {
                Log.logMid(`Setting array length to ${val_c}`);
                const newLength = this.ctx.mkIntVar(`${array.getName()}_Length_${array.incrementLengthCounter()}`);
                this.pushCondition(this.ctx.mkAnd(this.ctx.mkGe(newLength, val_s), this.ctx.mkGe(newLength, this.ctx.mkIntVal(0))));
                array.setLength(newLength);
            }
        }
    }
    
    _symbolicFieldSeqLookup(base_c, base_s, field_c, field_s) {
        return this.ctx.mkSeqAt(base_s, this.ctx.mkRealToInt(field_s));
    }

    /**
     * Pushes symbolic condition for valid array access based on concrete result and returns concrete result
     */
    _isFieldAccessWithinBounds(base_c, base_s, field_c, field_s) {
        if (!Number.isInteger(field_c)){
            return false;
        }

        const isValidConcreteIndex = field_c >= 0 && field_c < 4294967295 && field_c < base_c.length;
        
        /*  If valid -> length >=0 ^ length > field
            If not valid -> length < 0 v length <= field -> (due to assert length > 0) -> length <= field 
        */
        const isValidSymbolicIndex = this.ctx.mkAnd(
            this.ctx.mkGe(field_s, this.ctx.mkIntVal(0)),
            this.ctx.mkLt(field_s, base_s.getLength())
        );
        // Pushing the condition like this allows it to be negated to create an additional path
        return this.symbolicConditional(new ConcolicValue(isValidConcreteIndex, isValidSymbolicIndex));
    }

    _symbolicFieldArrayLookup(base_c, base_s, field_c, field_s) {
        const withinArrayBounds = this._isFieldAccessWithinBounds(base_c, base_s, field_c, field_s);
        Log.logMid(`Get from Array Index ${field_c}`);
        if (withinArrayBounds) {
            Log.logMid('Within Bounds: returning select from index');
            return base_s.selectFromIndex(this.ctx.mkRealToInt(field_s));
        } else {
            Log.logMid('Not within array bounds: returning undefined');
            return undefined;
        }
    }

    symbolicField(base_c, base_s, field_c, field_s) {
        if (typeof base_c === "string" && typeof field_c === "number") {
            return this._symbolicFieldSeqLookup(base_c, base_s, field_c, field_s);
        } else if (Config.arraysEnabled && base_c instanceof Array && typeof field_c === "number") {
            return this._symbolicFieldArrayLookup(base_c, base_s, field_c, field_s);
        } else {           
                switch (field_c) {
                case 'length':                
                if (typeof base_c === "string") {
                    //TODO: This is a stupid solution to a more fundamental problem in Z3
                    //Remove ASAP
                    let res = this.ctx.mkSeqLength(base_s);
                    //res.FORCE_EQ_TO_INT = true;
                    return res;
                } else if (base_c instanceof Array) {
                    return base_s.getLength(); 
                }
                default:
                    Log.log('Unsupported symbolic field - concretizing' + base_c + ' (type:' + typeof base_c + ') and field ' + field_c);
            }
        }

    	return undefined;
    }

    symbolicCoerceToBool(val_c, val_s) {
        let result = undefined;

        if (typeof val_c === "boolean") {
            result = val_s;
        } else if (typeof val_c === "number") {
            result = this.symbolicBinary('!=', val_c, val_s, 0, this.wrapConstant(0));
        } else if (typeof val_c === "string") {
            result = this.symbolicBinary('!=', val_c, val_s, "", this.wrapConstant(""));
        } else {
            Log.logMid('Cannot coerce '+ val_c + ' to boolean');
        }

        return result;
    }

    symbolicUnary(op, left_c, left_s) {
        switch (op) {
        case "!": {
            let bool_s = this.symbolicCoerceToBool(left_c, left_s);
            return bool_s ? this.ctx.mkNot(bool_s) : undefined;
        }
        case "+": {

            switch (typeof left_c) {
            case 'string':
                return this.ctx.mkStrToInt(left_s);
            }

            //For numeric types, +N => N
            //I don't see this being done often, generally only used to coerce
            //But some tit might write var x = +5;
            return left_s;
        }
        case "-":
                
            switch (typeof left_c) {
            case 'string':
                Log.log('Casting string to int, if its a real you will get incorrect result');
                return this.ctx.mkStrToInt(left_s);
            }

            return this.ctx.mkUnaryMinus(left_s);
        case "typeof":
            return undefined;
        default:
            Log.logMid("Unsupported operand: " + op);
            return undefined;
        }
    }

    wrapConstant(val) {
        switch (typeof val) {
        case 'boolean':
            return val ? this.ctx.mkTrue() : this.ctx.mkFalse();
        case 'number':
            return Math.round(val) === val ? this.ctx.mkReal(val, 1) : this.ctx.mkNumeral(String(val), this.realSort);
        case 'string':
            return this.ctx.mkString(val.toString());
        default:
            Log.log("Symbolic expressions with " + typeof val + " literals not yet supported.");
        }
    }
}

export default SymbolicState;
