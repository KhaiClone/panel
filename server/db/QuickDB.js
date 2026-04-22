const { QuickDB } = require("quick.db");
const { nanoid } = require("nanoid");

/**
 * Extended QuickDB class with MongoDB-like query methods.
 * All records stored in arrays keyed by model name.
 * Each record gets a unique `_id` via nanoid(24).
 */
class QuickDBExtension extends QuickDB {
    constructor(options) {
        super(options);
    }

    /** Insert a single record, auto-assigning `_id` */
    async create(model, data) {
        data._id = nanoid(24);
        await this.push(model, data);
        return data;
    }

    /** Insert multiple records at once */
    async createMany(model, arrayData) {
        arrayData = arrayData.map((e) => {
            e._id = nanoid(24);
            return e;
        });
        await this.push(model, ...arrayData);
        return arrayData;
    }

    /** Find all records matching a partial query object */
    async find(model, query = {}) {
        return ((await this.get(model)) || []).filter((e) => {
            for (const key in query) {
                if (e[key] !== query[key]) return false;
            }
            return true;
        });
    }

    /** Find first record matching a partial query object */
    async findOne(model, query) {
        return ((await this.get(model)) || []).filter((e) => {
            for (const key in query) {
                if (e[key] !== query[key]) return false;
            }
            return true;
        })[0];
    }

    /** Find a record by query and update it with new fields */
    async findOneAndUpdate(model, query, data) {
        if (data?._id) throw new Error("You can't change _id");

        const oldData = (await this.get(model)) || [];
        var newData = oldData;
        const index = oldData.findIndex((e) => {
            for (const key in query) {
                if (e[key] !== query[key]) return false;
            }
            return true;
        });
        if (index === -1) return null;
        newData[index] = { ...oldData[index], ...data };
        await this.set(model, newData);
        return newData[index];
    }

    /** Find a record by query and delete it, returns deleted record */
    async findOneAndDelete(model, query) {
        const oldData = (await this.get(model)) || [];
        const index = oldData.findIndex((e) => {
            for (const key in query) {
                if (e[key] !== query[key]) return false;
            }
            return true;
        });
        if (index === -1) return null;
        const newData = [...oldData];
        newData.splice(index, 1);
        await this.set(model, newData);
        return oldData[index];
    }

    /** Delete all records matching a query, returns deleted records */
    async deleteMany(model, query) {
        const oldData = (await this.get(model)) || [];
        const deleted = oldData.filter((e) => {
            for (const key in query) {
                if (e[key] !== query[key]) return false;
            }
            return true;
        });
        const newData = oldData.filter((e) => {
            for (const key in query) {
                if (e[key] !== query[key]) return true;
            }
            return false;
        });
        await this.set(model, newData);
        return deleted;
    }
}

module.exports = QuickDBExtension;
