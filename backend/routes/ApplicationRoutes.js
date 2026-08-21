const express = require("express");

const router = express.Router();

const {
  createApplication,
  getApplications,
} = require("../controllers/applicationController");
const { protect } = require("../middleware/Auth");
const verifyRole = require("../middleware/verifyRole");
const documentController = require("../controllers/admissionDocumentController");

router.post("/", createApplication);
router.get("/", protect, verifyRole("admin"), getApplications);

// ---- Supporting documents ----
// `protect` is applied per route rather than with router.use, so the public
// POST "/" above stays public — an applicant has to be able to apply without
// an account, and nothing here should change that.
const admissions = verifyRole("admin", "staff");
const registrar = verifyRole("admin");

router.get("/documents/meta", protect, admissions, documentController.getDocumentMeta);
router.get("/documents/outstanding", protect, admissions, documentController.getOutstanding);
router.get("/documents/stats", protect, registrar, documentController.getDocumentStats);

// Requirement rules — the matrix of what each grade has to produce.
router.post("/documents/requirements", protect, registrar, documentController.createRequirement);
router.get("/documents/requirements", protect, admissions, documentController.getRequirements);
router.patch("/documents/requirements/:id", protect, registrar, documentController.updateRequirement);
router.patch(
  "/documents/requirements/:id/retire",
  protect,
  registrar,
  documentController.retireRequirement
);

// One document. "item" keeps these off the ":applicationId" branch below.
router.patch("/documents/item/:id/verify", protect, admissions, documentController.verifyDocument);
router.patch("/documents/item/:id/reject", protect, admissions, documentController.rejectDocument);

// Per application.
router.post("/documents/:applicationId", protect, admissions, documentController.receiveDocument);
router.get("/documents/:applicationId", protect, admissions, documentController.getDocuments);
router.get("/documents/:applicationId/checklist", protect, admissions, documentController.getChecklist);
router.get("/documents/:applicationId/clearance", protect, admissions, documentController.getClearance);

module.exports = router;