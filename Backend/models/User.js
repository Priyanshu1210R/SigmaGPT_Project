import mongoose from "mongoose";
import bcrypt from "bcryptjs";

const UserSchema = new mongoose.Schema({
  username: {
    type: String,
    required: true,
    trim: true,
  },
  email: {
    type: String,
    required: true,
    unique: true,
    lowercase: true,
    trim: true,
  },
  password: {
    type: String,
    required: true,
  },
  createdAt: {
    type: Date,
    default: Date.now,
  },
});

// Hash password before saving
UserSchema.pre("save", async function (next) {

    try {

        if (!this.isModified("password")) {
            return next();
        }

        const salt = await bcrypt.genSalt(10);

        this.password = await bcrypt.hash(
            this.password,
            salt
        );

        next();

    } catch (err) {

        next(err);

    }

});

// Compare plain password with hashed
UserSchema.methods.comparePassword = async function (plainPassword) {
  return bcrypt.compare(plainPassword, this.password);
};

export default mongoose.model("User", UserSchema);
