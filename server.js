const express = require("express");
const sql = require("mssql");
const cors = require("cors");

const multer = require('multer');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));


const storage = multer.memoryStorage();  // Store the file in memory as a buffer
const upload = multer({ storage: storage });


// SQL Server configuration
const dbConfig = {
    user: "sa",
    password: "123456",
    server: "LAPTOP-AAIO1HUT",
    database: "pan_shop",
    options: {
        encrypt: true,
        trustServerCertificate: true,
    },
};

// Function to connect to MSSQL
const connectToDatabase = async () => {
    try {
        await sql.connect(dbConfig);
        console.log("Connected to MSSQL Server");
    } catch (err) {
        console.error("Database connection failed:", err.message);

        // Retry logic (optional)
        setTimeout(() => {
            console.log("Retrying connection...");
            connectToDatabase();
        }, 5000); // Retry every 5 seconds
    }
};

// Connect to the database
connectToDatabase();

// API Endpoints
app.get("/inventory", async (req, res) => {
    try {
        const result = await sql.query("SELECT * FROM inventory");

        const formattedData = result.recordset.map(item => ({
            ...item,
            ProductImage: item.ProductImage
                ? `data:image/jpeg;base64,${Buffer.from(item.ProductImage).toString('base64')}`
                : null
        }));

        res.json(formattedData);
    } catch (err) {
        console.error("Error fetching inventory data:", err);
        res.status(500).send("Error fetching inventory data");
    }
});




app.post("/inventory", upload.single("productImage"), async (req, res) => {
    try {
        const { productName, quantity, price, selling } = req.body;
        const productImage = req.file ? req.file.buffer.toString("base64") : null; // Store as Base64

        const total = quantity * selling;

        const query = `
            INSERT INTO Inventory (ProductName, Quantity, Price, Selling, Total, ProductImage) 
            VALUES (@ProductName, @Quantity, @Price, @Selling, @Total, @ProductImage)
        `;

        const request = new sql.Request();
        request.input("ProductName", sql.NVarChar, productName);
        request.input("Quantity", sql.Int, quantity);
        request.input("Price", sql.Decimal(10, 2), price);
        request.input("Selling", sql.Decimal(10, 2), selling);
        request.input("Total", sql.Decimal(10, 2), total);
        request.input("ProductImage", sql.VarBinary(sql.MAX), Buffer.from(productImage, "base64"));

        await request.query(query);

        res.status(201).send("Product added successfully.");
    } catch (err) {
        console.error("Error adding product:", err);
        res.status(500).send("Failed to add product.");
    }
});

// Fetch individual product details by InventoryID
app.get("/inventory/:id", async (req, res) => {
    const { id } = req.params;

    try {
        const query = "SELECT * FROM inventory WHERE InventoryID = @id";
        const request = new sql.Request();
        request.input("id", sql.Int, id);

        const result = await request.query(query);
        if (result.recordset.length > 0) {
            res.json(result.recordset[0]);
        } else {
            res.status(404).send("Product not found");
        }
    } catch (err) {
        console.error("Error fetching product details:", err);
        res.status(500).send("Error fetching product details");
    }
});

app.put("/inventory/:id", upload.single('ProductImage'), async (req, res) => {
    const { id } = req.params;
    const { ProductName, Quantity, Price, Selling } = req.body;
    const ProductImage = req.file ? req.file.buffer : null;

    // Validate the data
    if (!ProductName || !Quantity || !Price || !Selling) {
        return res.status(400).json({ error: "Missing required fields." });
    }

    try {
        const query = `
            UPDATE Inventory
            SET ProductName = @ProductName,
                Quantity = @Quantity,
                Price = @Price,
                Selling = @Selling,
                ProductImage = @ProductImage
            WHERE InventoryID = @InventoryID
        `;

        const request = new sql.Request();
        request.input("InventoryID", sql.Int, id);
        request.input("ProductName", sql.VarChar, ProductName);
        request.input("Quantity", sql.Int, Quantity);
        request.input("Price", sql.Float, Price);
        request.input("Selling", sql.Float, Selling);
        if (ProductImage) {
            request.input("ProductImage", sql.VarBinary(sql.MAX), ProductImage);
        } else {
            request.input("ProductImage", sql.VarBinary(sql.MAX), null);
        }

        await request.query(query);
        res.status(200).json({ message: "Product updated successfully" });
    } catch (err) {
        console.error("SQL Error:", err);
        res.status(500).json({ error: "Failed to update product", details: err });
    }
});




// Delete product from the inventory
app.delete("/inventory/:id", async (req, res) => {
    const { id } = req.params;

    try {
        const query = "DELETE FROM inventory WHERE InventoryID = @id";
        const request = new sql.Request();
        request.input("id", sql.Int, id);
        await request.query(query);
        res.status(200).send("Product deleted successfully");
    } catch (err) {
        console.error("Error deleting product:", err);
        res.status(500).send("Error deleting product");
    }
});

// Fetch all sellings
app.get("/sellings", async (req, res) => {
    try {
        const result = await sql.query("SELECT * FROM selling");
        res.json(result.recordset); // Send the fetched data as JSON
    } catch (err) {
        console.error("Error fetching sellings:", err);
        res.status(500).send("Error fetching sellings");
    }
});

// Add a sale
app.post("/sellings", async (req, res) => {
    const { InventoryID, PersonName, ProductName, Quantity, Price, Total } = req.body;

    if (!InventoryID || !PersonName || !ProductName || !Quantity || !Price || !Total) {
        return res.status(400).json({ message: "All fields are required" });
    }

    let transaction;

    try {
        // Start a transaction
        transaction = new sql.Transaction();
        await transaction.begin();

        const request = new sql.Request(transaction);

        // Check inventory quantity
        const checkInventoryQuery = "SELECT Quantity FROM inventory WHERE InventoryID = @InventoryID";
        request.input("InventoryID", sql.Int, InventoryID);

        const inventoryResult = await request.query(checkInventoryQuery);

        if (inventoryResult.recordset.length === 0) {
            await transaction.rollback();
            return res.status(404).json({ message: "Inventory item not found" });
        }

        const currentQuantity = inventoryResult.recordset[0].Quantity;

        // Check if there is sufficient stock
        if (currentQuantity < Quantity) {
            await transaction.rollback(); // Rollback the transaction
            return res.status(400).json({ message: "Insufficient stock available" });
        }

        // Update inventory quantity
        const updatedQuantity = currentQuantity - Quantity;
        const updateInventoryQuery = `
            UPDATE inventory
            SET Quantity = @updatedQuantity
            WHERE InventoryID = @InventoryID
        `;
        request.input("updatedQuantity", sql.Int, updatedQuantity);
        await request.query(updateInventoryQuery);

        // Add the sale record
        const addSaleQuery = `
            INSERT INTO selling (InventoryID, PersonName, ProductName, Quantity, Price, Total)
            VALUES (@InventoryID, @PersonName, @ProductName, @Quantity, @Price, @Total)
        `;
        request.input("PersonName", sql.NVarChar, PersonName);
        request.input("ProductName", sql.NVarChar, ProductName);
        request.input("Quantity", sql.Int, Quantity);
        request.input("Price", sql.Decimal(10, 2), Price);
        request.input("Total", sql.Decimal(10, 2), Total);

        await request.query(addSaleQuery);

        // Commit the transaction
        await transaction.commit();
        res.status(201).json({ message: "Sale added successfully" });
    } catch (err) {
        console.error("Error adding sale:", err);

        // Rollback transaction in case of error
        if (transaction) {
            await transaction.rollback();
        }

        res.status(500).json({ message: "Sale addition failed" });
    }
});



app.post('/signup', async (req, res) => {
    console.log("Signup request received", req.body);  // Debug log
  
    const { username, password } = req.body;
  
    if (!username || !password) {
      return res.status(400).json({ message: "Username and password are required" });
    }
  
    try {
      let pool = await sql.connect(dbConfig);
      const result = await pool
        .request()
        .input('UserName', sql.VarChar, username)
        .input('Password', sql.VarChar, password)
        .query('SELECT * FROM UserLogin WHERE UserName = @UserName');
  
      if (result.recordset.length > 0) {
        return res.status(400).json({ message: 'Username already exists' });
      }
  
      await pool
        .request()
        .input('UserName', sql.VarChar, username)
        .input('Password', sql.VarChar, password)
        .query('INSERT INTO UserLogin (UserName, Password) VALUES (@UserName, @Password)');
  
      return res.status(201).json({ message: 'Signup successful' });
    } catch (err) {
      console.error("Database error:", err);  // Debug error
      res.status(500).json({ message: 'Database error' });
    }
  });

// Handle user login
app.post('/login', async (req, res) => {
    const { username, password } = req.body;

    try {
        let pool = await sql.connect(dbConfig);
        const result = await pool
            .request()
            .input('UserName', sql.VarChar, username)
            .input('Password', sql.VarChar, password)
            .query('SELECT * FROM UserLogin WHERE UserName = @UserName AND Password = @Password');

        if (username === "rohanashara" && password === "1234567") {
            res.json({ message: 'Admin Login successful', role: 'admin', username });
        } else if (result.recordset.length > 0) {
            res.json({ message: 'User Login successful', role: 'user', username });
        } else {
            res.status(401).json({ message: 'Invalid username or password' });
        }
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Database error' });
    }
});


app.put("/inventory/:id", async (req, res) => {
    const { id } = req.params;
    const updates = req.body;

    try {
        const fields = Object.keys(updates)
            .map(key => `${key} = @${key}`)
            .join(", ");

        const request = new sql.Request();
        request.input("InventoryID", sql.Int, id);

        Object.keys(updates).forEach(key => {
            request.input(key, sql.NVarChar, updates[key]);
        });

        const query = `UPDATE Inventory SET ${fields} WHERE InventoryID = @InventoryID`;
        await request.query(query);
        res.status(200).json({ message: "Product updated successfully" });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Failed to update product" });
    }
});

app.put('/inventory/:id', async (req, res) => {
    const id = req.params.id;
    const { ProductName, Quantity, Price, Selling } = req.body;

    // Calculate the new total for the product
    const Total = Quantity * Selling;

    try {
        await db.query(
            "UPDATE Inventory SET ProductName = ?, Quantity = ?, Price = ?, Selling = ?, Total = ? WHERE InventoryID = ?",
            [ProductName, Quantity, Price, Selling, Total, id]
        );
        res.status(200).send("Product updated successfully!");
    } catch (error) {
        console.error("Error updating inventory:", error);
        res.status(500).send("Failed to update product");
    }
});






// Start the server
const PORT = 3000; // Ensure this matches the port your frontend is using
app.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`);
});
